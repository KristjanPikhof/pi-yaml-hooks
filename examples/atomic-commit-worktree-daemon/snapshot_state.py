#!/usr/bin/env python3
"""Worktree-local state and replay helpers for the daemon example.

This is a conservative, runnable foundation for the example only. It keeps the
queue in a worktree-local SQLite DB, coordinates branch ownership through the
shared branch-registry pattern from ``snapshot_shared.py``, and quarantines
incompatible local state instead of trying to muddle through.
"""

from __future__ import annotations

import fcntl
import errno
import os
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from snapshot_shared import (
    IncompatibleLocalStateError,
    LOCAL_STATE_SCHEMA_VERSION,
    STATE_DIR_MODE,
    STATE_FILE_MODE,
    branch_worktree_git_dirs,
    current_head,
    ensure_branch_registry,
    ensure_state_dir,
    git_bin,
    local_state_dir,
    quarantine_incompatible_local_state,
    resolve_repo_paths as _resolve_repo_paths,
    restrict_file_perms,
    restricted_umask,
)


STATE_SUBDIR = "ai-snapshotd"
DB_NAME = "daemon.db"
LOCK_NAME = "daemon.lock"
CONTROL_LOCK_NAME = "control.lock"
PUBLISH_LOCK_NAME = "publish.lock"
INDEX_NAME = "worker.index"
SCHEMA_VERSION = LOCAL_STATE_SCHEMA_VERSION  # single source of truth across processes


# Only identity/commit metadata and a narrow, explicitly-passed GIT_INDEX_FILE
# survive into git subprocesses. Everything else (GIT_DIR, GIT_WORK_TREE,
# GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG, …) is
# stripped so a hostile parent environment cannot redirect the daemon's git
# operations to an attacker-controlled repo.
_GIT_ENV_ALLOWLIST = (
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
)


# Pinned safe PATH used to resolve ``git`` and to harden the env passed to
# subprocess git. Mirrors ``snapshot_shared._SAFE_PATH``; both copies must
# stay aligned so the resolved git binary is identical across modules.
_SAFE_PATH = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/sbin:/sbin"


def _clean_git_env(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    base = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    for name in _GIT_ENV_ALLOWLIST:
        value = os.environ.get(name)
        if value is not None:
            base[name] = value
    base.setdefault("GIT_TERMINAL_PROMPT", "0")
    # Override PATH with the trusted PATH used to resolve ``git`` so child
    # git processes that exec sub-helpers (e.g. ``git-remote-https``) cannot
    # be redirected by an attacker-controlled inherited PATH.
    base["PATH"] = _SAFE_PATH
    if extra:
        base.update(extra)
    return base


# Default-deny glob list for paths whose bytes must never enter the git object
# store: credential files, SSH/TLS private keys, kubeconfigs, password stores,
# cloud/service-account tokens, and signed-key bundles. Operators can override
# or extend via the SNAPSHOTD_SENSITIVE_GLOBS env var.
DEFAULT_SENSITIVE_GLOBS = (
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    ".npmrc",
    "**/.npmrc",
    ".netrc",
    "**/.netrc",
    ".pgpass",
    "**/.pgpass",
    ".git-credentials",
    "**/.git-credentials",
    "kubeconfig",
    "**/kubeconfig",
    "**/.aws/credentials",
    "**/.docker/config.json",
    "**/.kube/config",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/id_ecdsa*",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/*.crt",
    "**/*.pkcs8",
    "**/*.kdbx",
    "**/service-account*.json",
    "**/*.gpg",
    "**/*.asc",
    "**/secrets/*",
    "**/credentials*",
)


class SensitivePathRefused(RuntimeError):
    """Raised when a caller tries to persist a path matching the sensitive glob list."""


def _expand_globs(patterns: Iterable[str]) -> Tuple[str, ...]:
    """Expand ``**/foo`` to also match top-level ``foo``.

    fnmatch does not understand the ``**`` recursive prefix the way gitignore
    does — ``**/secrets/*`` matches ``a/secrets/x`` but not the bare top-level
    ``secrets/x``. The daemon needs gitignore-equivalent semantics so a secret
    in the repo root is not silently allowed through. We pair every ``**/X``
    pattern with its bare ``X`` form, which together cover both root-level
    and nested matches under fnmatch.
    """
    expanded: List[str] = []
    seen: set[str] = set()
    for pattern in patterns:
        if pattern not in seen:
            expanded.append(pattern)
            seen.add(pattern)
        if pattern.startswith("**/"):
            tail = pattern[3:]
            if tail and tail not in seen:
                expanded.append(tail)
                seen.add(tail)
    return tuple(expanded)


def _sensitive_patterns() -> Tuple[str, ...]:
    """Return the active sensitive-path glob list.

    ``SNAPSHOTD_SENSITIVE_GLOBS`` semantics:
        * unset, empty, or whitespace-only -> use ``DEFAULT_SENSITIVE_GLOBS``.
          Treating an empty override as "disable all filtering" was a
          foot-gun: shell exports like ``SNAPSHOTD_SENSITIVE_GLOBS=""`` are
          easy to write by accident and would silently let secrets enter the
          object store. The safe baseline always applies unless the operator
          provides an explicit non-empty override.
        * non-empty -> parse comma-separated patterns; whitespace is trimmed
          and empty entries are dropped.

    Patterns are then expanded so fnmatch matches gitignore-style ``**/`` at
    the repo root.
    """
    override = os.environ.get("SNAPSHOTD_SENSITIVE_GLOBS")
    if override is None or not override.strip():
        return _expand_globs(DEFAULT_SENSITIVE_GLOBS)
    parsed = tuple(p.strip() for p in override.split(",") if p.strip())
    if not parsed:
        return _expand_globs(DEFAULT_SENSITIVE_GLOBS)
    return _expand_globs(parsed)


def is_sensitive_path(rel: str) -> bool:
    import fnmatch
    return any(fnmatch.fnmatch(rel, pattern) for pattern in _sensitive_patterns())


def db_path(git_dir: Path) -> Path:
    return local_state_dir(git_dir) / DB_NAME


def resolve_repo_paths(cwd: Path) -> Tuple[Path, Path, Path]:
    return _resolve_repo_paths(cwd)


def index_path(git_dir: Path) -> Path:
    return local_state_dir(git_dir) / INDEX_NAME


def lock_path(git_dir: Path) -> Path:
    return local_state_dir(git_dir) / LOCK_NAME


def _connect(git_dir: Path) -> sqlite3.Connection:
    path = db_path(git_dir)
    ensure_state_dir(path.parent)
    with restricted_umask():
        conn = sqlite3.connect(str(path), timeout=10.0, isolation_level=None)
    restrict_file_perms(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """Wrap a block in BEGIN IMMEDIATE / COMMIT, rolling back on error.

    All schema-modifying or multi-row writers should use this so a crash mid-
    write does not leave the DB partially-updated. Autocommit (the connection
    default) is fine for single-statement reads/writes.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass
        raise


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Create tables if missing and bump user_version atomically.

    Wrapped in BEGIN IMMEDIATE so a crash mid-bootstrap cannot leave half the
    schema present with an unset version.
    """
    with transaction(conn):
        conn.execute(
            """CREATE TABLE IF NOT EXISTS daemon_state(
                   id INTEGER PRIMARY KEY CHECK (id = 1),
                   pid INTEGER NOT NULL DEFAULT 0,
                   mode TEXT NOT NULL DEFAULT 'stopped',
                   heartbeat_ts REAL NOT NULL DEFAULT 0,
                   branch_ref TEXT,
                   branch_generation INTEGER,
                   note TEXT,
                   daemon_token TEXT,
                   daemon_fingerprint TEXT,
                   updated_ts REAL NOT NULL
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS shadow_paths(
                   branch_ref TEXT NOT NULL,
                   branch_generation INTEGER NOT NULL,
                   path TEXT NOT NULL,
                   operation TEXT NOT NULL,
                   mode TEXT,
                   oid TEXT,
                   old_path TEXT,
                   base_head TEXT NOT NULL,
                   fidelity TEXT NOT NULL,
                   updated_ts REAL NOT NULL,
                   PRIMARY KEY (branch_ref, branch_generation, path)
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS capture_events(
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   branch_ref TEXT NOT NULL,
                   branch_generation INTEGER NOT NULL,
                   base_head TEXT NOT NULL,
                   operation TEXT NOT NULL,
                   path TEXT NOT NULL,
                   old_path TEXT,
                   fidelity TEXT NOT NULL,
                   captured_ts REAL NOT NULL,
                   published_ts REAL,
                   state TEXT NOT NULL DEFAULT 'pending',
                   commit_oid TEXT,
                   error TEXT
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS capture_ops(
                   event_seq INTEGER NOT NULL,
                   ord INTEGER NOT NULL,
                   op TEXT NOT NULL,
                   path TEXT NOT NULL,
                   old_path TEXT,
                   before_oid TEXT,
                   before_mode TEXT,
                   after_oid TEXT,
                   after_mode TEXT,
                   fidelity TEXT NOT NULL,
                   PRIMARY KEY (event_seq, ord),
                   FOREIGN KEY(event_seq) REFERENCES capture_events(seq) ON DELETE CASCADE
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS flush_requests(
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   command TEXT NOT NULL,
                   non_blocking INTEGER NOT NULL DEFAULT 0,
                   requested_ts REAL NOT NULL,
                   acknowledged_ts REAL,
                   completed_ts REAL,
                   status TEXT NOT NULL DEFAULT 'pending',
                   note TEXT
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS publish_state(
                   id INTEGER PRIMARY KEY CHECK (id = 1),
                   event_seq INTEGER,
                   branch_ref TEXT,
                   branch_generation INTEGER,
                   source_head TEXT,
                   target_commit_oid TEXT,
                   status TEXT NOT NULL DEFAULT 'idle',
                   error TEXT,
                   updated_ts REAL NOT NULL
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS daemon_meta(
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   updated_ts REAL NOT NULL
               )"""
        )
        conn.execute(
            """INSERT OR IGNORE INTO daemon_state(id, pid, mode, heartbeat_ts, updated_ts)
               VALUES (1, 0, 'stopped', 0, ?)""",
            (time.time(),),
        )
        conn.execute(
            """INSERT OR IGNORE INTO publish_state(id, updated_ts)
               VALUES (1, ?)""",
            (time.time(),),
        )
        # PRAGMA user_version cannot be parameterized; SCHEMA_VERSION is an int
        # constant defined in this module so f-string interpolation is safe.
        conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")


def _column_names(conn: sqlite3.Connection, table: str) -> Tuple[str, ...]:
    return tuple(row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall())


def _migrate_schema(conn: sqlite3.Connection, current_version: int) -> None:
    """Apply additive ALTERs for known prior schemas.

    Each step only runs when the column is actually missing — the operation
    is idempotent across re-entries. Reaching a version newer than this
    process knows about still raises so we never silently truncate columns.
    """
    if current_version > SCHEMA_VERSION:
        raise IncompatibleLocalStateError(
            f"daemon DB user_version={current_version} is newer than supported {SCHEMA_VERSION}"
        )
    if current_version == 0:
        return
    daemon_cols = set(_column_names(conn, "daemon_state"))
    if "daemon_token" not in daemon_cols:
        # v2 → v3 added the identity token used to gate signal delivery.
        conn.execute("ALTER TABLE daemon_state ADD COLUMN daemon_token TEXT")
    if "daemon_fingerprint" not in daemon_cols:
        # v3 → v4 added the OS-bound process-start-time fingerprint that
        # closes the PID-reuse window the bare token check left open.
        conn.execute("ALTER TABLE daemon_state ADD COLUMN daemon_fingerprint TEXT")
    capture_cols = set(_column_names(conn, "capture_events")) if (
        "capture_events" in {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    ) else set()
    if capture_cols and "published_ts" not in capture_cols:
        # v4 added a publish-time stamp so retention can be measured from
        # publish, not capture, for events that sat pending across a window.
        conn.execute("ALTER TABLE capture_events ADD COLUMN published_ts REAL")


def open_state(git_dir: Path, allow_reset: bool = True) -> sqlite3.Connection:
    """Open or create the daemon state DB.

    Distinguishes three failure modes that ``ensure_state`` handles
    differently: an incompatible-but-readable schema (quarantine), a corrupt
    DB file (also quarantine — surface as ``IncompatibleLocalStateError``),
    and any other unexpected error (propagate raw so the caller can log it).
    """
    try:
        conn = _connect(git_dir)
    except sqlite3.DatabaseError as exc:
        # "file is not a database" / "database disk image is malformed" /
        # "file is encrypted or is not a database". README promises that
        # corrupt local DBs are quarantined, not crash the daemon forever.
        raise IncompatibleLocalStateError(f"daemon DB unreadable: {exc}") from exc
    try:
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if version > SCHEMA_VERSION:
            raise IncompatibleLocalStateError(
                f"daemon DB user_version={version} is newer than supported {SCHEMA_VERSION}"
            )
        if version not in (0, SCHEMA_VERSION):
            _migrate_schema(conn, version)
        _ensure_schema(conn)
        return conn
    except sqlite3.DatabaseError as exc:
        try:
            conn.close()
        except sqlite3.Error:
            pass
        raise IncompatibleLocalStateError(f"daemon DB read error: {exc}") from exc


def ensure_state(git_dir: Path) -> sqlite3.Connection:
    try:
        return open_state(git_dir)
    except IncompatibleLocalStateError as exc:
        quarantined = quarantine_incompatible_local_state(git_dir, str(exc))
        if quarantined is None:
            raise
        conn = _connect(git_dir)
        _ensure_schema(conn)
        return conn


def _row_to_dict(row: Optional[sqlite3.Row]) -> Dict[str, Any]:
    return dict(row) if row is not None else {}


def load_shadow_paths(
    conn: sqlite3.Connection,
    *,
    branch_ref: str,
    branch_generation: int,
) -> Dict[str, Dict[str, Any]]:
    """Return the shadow map for one ``(branch_ref, branch_generation)`` pair.

    Both arguments are required keyword-only. The previous opt-in form was a
    foot-gun: a forgetful caller could pass ``branch_ref=None`` and silently
    pull rows from every branch, which mixes stale shadow entries from one
    branch into another's change classification and produces phantom events.
    """
    if branch_ref is None or branch_generation is None:
        raise TypeError("load_shadow_paths requires branch_ref and branch_generation")
    rows = conn.execute(
        """SELECT path, operation, mode, oid, old_path, branch_ref,
                  branch_generation, base_head, fidelity, updated_ts
           FROM shadow_paths WHERE branch_ref=? AND branch_generation=?""",
        (branch_ref, branch_generation),
    ).fetchall()
    return {row["path"]: dict(row) for row in rows}


def load_all_shadow_paths_unscoped(conn: sqlite3.Connection) -> Dict[str, List[Dict[str, Any]]]:
    """Diagnostic-only reader returning shadow rows grouped by ``(branch_ref, generation)``."""
    rows = conn.execute(
        """SELECT path, operation, mode, oid, old_path, branch_ref,
                  branch_generation, base_head, fidelity, updated_ts
           FROM shadow_paths"""
    ).fetchall()
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        key = f"{row['branch_ref']}@{row['branch_generation']}"
        grouped.setdefault(key, []).append(dict(row))
    return grouped


def replace_shadow_paths(
    conn: sqlite3.Connection,
    *,
    branch_ref: str,
    branch_generation: int,
    base_head: str,
    entries: Iterable[Dict[str, Any]],
    fidelity: str = "rescan",
) -> None:
    now = time.time()
    # Scoped DELETE: rebuilding branch A's shadow must not wipe branch B's.
    conn.execute(
        "DELETE FROM shadow_paths WHERE branch_ref=? AND branch_generation=?",
        (branch_ref, branch_generation),
    )
    for entry in entries:
        conn.execute(
            """INSERT INTO shadow_paths(path, operation, mode, oid, old_path,
               branch_ref, branch_generation, base_head, fidelity, updated_ts)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                entry["path"],
                entry.get("operation", "baseline"),
                entry.get("mode"),
                entry.get("oid"),
                entry.get("old_path"),
                branch_ref,
                branch_generation,
                base_head,
                entry.get("fidelity", fidelity),
                now,
            ),
        )


def get_daemon_meta(conn: sqlite3.Connection, key: str) -> Optional[str]:
    row = conn.execute("SELECT value FROM daemon_meta WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row else None


def set_daemon_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """INSERT INTO daemon_meta(key, value, updated_ts) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts""",
        (key, value, time.time()),
    )


class DetachedHeadError(RuntimeError):
    """Raised when HEAD does not point at a writable branch under refs/heads/."""


def repo_context(repo_input: Path, explicit_git_dir: Optional[Path] = None) -> Dict[str, Any]:
    repo_root, git_dir, common_dir = resolve_repo_paths(repo_input)
    if explicit_git_dir is not None:
        git_dir = explicit_git_dir.resolve()
    branch = current_branch(repo_root)
    head = current_head(repo_root)
    if branch is None:
        raise DetachedHeadError("detached or unborn HEAD is not replay-safe")
    if not branch.startswith("refs/heads/"):
        # update-ref with a refs/tags/ or refs/remotes/ target would silently
        # move that ref. The daemon's safety model assumes a local branch.
        raise DetachedHeadError(
            f"HEAD points at {branch}, not a refs/heads/ branch — refusing to replay"
        )
    if not _check_ref_format(branch):
        raise DetachedHeadError(f"HEAD ref {branch} is not a valid ref name")
    if head is None:
        raise RuntimeError("unable to resolve HEAD")
    if len(branch_worktree_git_dirs(repo_root, branch)) > 1:
        raise RuntimeError(f"branch {branch} is checked out in multiple worktrees")
    branch_state = ensure_branch_registry(repo_root, git_dir, common_dir, branch, head)
    return {
        "repo_root": repo_root,
        "git_dir": git_dir,
        "common_dir": common_dir,
        "branch_ref": branch,
        "base_head": head,
        "branch_generation": int(branch_state["generation"]),
        "owner_git_dir": str(branch_state.get("owner_git_dir") or git_dir),
    }


def _check_ref_format(ref: str) -> bool:
    proc = subprocess.run(
        [git_bin(), "check-ref-format", ref],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=_clean_git_env(),
    )
    return proc.returncode == 0


def _hash_blob(repo_root: Path, data: bytes) -> str:
    proc = subprocess.run(
        [git_bin(), "hash-object", "-w", "--stdin"],
        cwd=str(repo_root),
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", errors="replace").strip())
    return proc.stdout.decode("utf-8", errors="replace").strip()


def record_event(
    conn: sqlite3.Connection,
    *,
    branch_ref: str,
    branch_generation: int,
    base_head: str,
    operation: str,
    path: str,
    old_path: Optional[str],
    fidelity: str,
    ops: List[Dict[str, Any]],
    captured_ts: Optional[float] = None,
) -> int:
    captured_ts = time.time() if captured_ts is None else captured_ts
    with transaction(conn):
        cur = conn.execute(
            """INSERT INTO capture_events(branch_ref, branch_generation, base_head, operation,
                   path, old_path, fidelity, captured_ts)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (branch_ref, branch_generation, base_head, operation, path, old_path, fidelity, captured_ts),
        )
        seq = int(cur.lastrowid or 0)
        for ord_, op in enumerate(ops):
            conn.execute(
                """INSERT INTO capture_ops(event_seq, ord, op, path, old_path,
                       before_oid, before_mode, after_oid, after_mode, fidelity)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    seq,
                    ord_,
                    op["op"],
                    op["path"],
                    op.get("old_path"),
                    op.get("before_oid"),
                    op.get("before_mode"),
                    op.get("after_oid"),
                    op.get("after_mode"),
                    op.get("fidelity", fidelity),
                ),
            )
        for op in ops:
            _update_shadow_path(conn, branch_ref, branch_generation, base_head, fidelity, op)
    return seq


def _update_shadow_path(
    conn: sqlite3.Connection,
    branch_ref: str,
    branch_generation: int,
    base_head: str,
    fidelity: str,
    op: Dict[str, Any],
) -> None:
    now = time.time()
    if op["op"] == "delete":
        conn.execute(
            "DELETE FROM shadow_paths WHERE branch_ref=? AND branch_generation=? AND path=?",
            (branch_ref, branch_generation, op["path"]),
        )
        return
    if op["op"] == "rename" and op.get("old_path"):
        conn.execute(
            "DELETE FROM shadow_paths WHERE branch_ref=? AND branch_generation=? AND path=?",
            (branch_ref, branch_generation, op["old_path"]),
        )
    conn.execute(
        """INSERT INTO shadow_paths(path, operation, mode, oid, old_path,
               branch_ref, branch_generation, base_head, fidelity, updated_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(branch_ref, branch_generation, path) DO UPDATE SET
              operation=excluded.operation,
              mode=excluded.mode,
              oid=excluded.oid,
              old_path=excluded.old_path,
              base_head=excluded.base_head,
              fidelity=excluded.fidelity,
              updated_ts=excluded.updated_ts""",
        (
            op["path"],
            op["op"],
            op.get("after_mode"),
            op.get("after_oid"),
            op.get("old_path"),
            branch_ref,
            branch_generation,
            base_head,
            fidelity,
            now,
        ),
    )


def capture_blob_for_text(repo_root: Path, text: str, rel_path: Optional[str] = None) -> str:
    if rel_path is not None and is_sensitive_path(rel_path):
        raise SensitivePathRefused(f"refusing to hash sensitive path: {rel_path}")
    return _hash_blob(repo_root, text.encode("utf-8"))


def capture_blob_for_bytes(repo_root: Path, data: bytes, rel_path: Optional[str] = None) -> str:
    if rel_path is not None and is_sensitive_path(rel_path):
        raise SensitivePathRefused(f"refusing to hash sensitive path: {rel_path}")
    return _hash_blob(repo_root, data)


def current_branch(repo_root: Path) -> Optional[str]:
    """Resolve HEAD to a symbolic ref, or ``None`` for detached/unborn HEAD.

    Distinguishes git's documented "not a symbolic ref" exit (returncode 1)
    from any other failure mode — a transient lock contention, broken HEAD,
    or permissions error should bubble up rather than silently pose as a
    detached HEAD and confuse downstream callers.
    """
    proc = subprocess.run(
        [git_bin(), "symbolic-ref", "-q", "HEAD"],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
    )
    if proc.returncode == 1:
        return None
    if proc.returncode != 0:
        raise RuntimeError(
            proc.stderr.decode("utf-8", errors="replace").strip()
            or f"git symbolic-ref failed with exit {proc.returncode}"
        )
    out = proc.stdout.decode("utf-8", errors="replace").strip()
    return out or None


def snapshot_state_for_index(repo_root: Path, env: Dict[str, str]) -> Dict[str, Tuple[str, str]]:
    proc = subprocess.run(
        ["git", "ls-files", "-s", "-z"],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    if proc.returncode != 0:
        return {}
    state: Dict[str, Tuple[str, str]] = {}
    for chunk in proc.stdout.split(b"\x00"):
        if not chunk:
            continue
        meta, _tab, path_bytes = chunk.partition(b"\t")
        parts = meta.split()
        if len(parts) < 2:
            continue
        state[os.fsdecode(path_bytes)] = (
            parts[0].decode(),
            parts[1].decode(),
        )
    return state


def apply_ops_to_index(repo_root: Path, env: Dict[str, str], ops: List[Dict[str, Any]]) -> None:
    lines: List[bytes] = []
    zero_oid = "0" * 40
    for op in ops:
        kind = op["op"]
        if kind in {"create", "modify", "mode", "symlink"}:
            mode = op.get("after_mode")
            oid = op.get("after_oid")
            if not mode or not oid:
                raise RuntimeError(
                    f"missing after_mode/after_oid for {kind} {op['path']}"
                )
            lines.append(f"{mode} {oid}\t{op['path']}".encode("utf-8"))
        elif kind == "delete":
            lines.append(f"0 {zero_oid}\t{op['path']}".encode("utf-8"))
        elif kind == "rename":
            if op.get("old_path"):
                lines.append(f"0 {zero_oid}\t{op['old_path']}".encode("utf-8"))
            mode = op.get("after_mode")
            oid = op.get("after_oid")
            if not mode or not oid:
                raise RuntimeError(
                    f"missing after_mode/after_oid for rename {op['path']}"
                )
            lines.append(f"{mode} {oid}\t{op['path']}".encode("utf-8"))
    if not lines:
        return
    payload = b"\x00".join(lines) + b"\x00"
    proc = subprocess.run(
        ["git", "update-index", "-z", "--index-info"],
        cwd=str(repo_root),
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", errors="replace").strip())


def build_message(event: sqlite3.Row, ops: List[Dict[str, Any]]) -> str:
    if len(ops) == 1:
        op = ops[0]
        kind = op["op"]
        if kind == "create":
            subject = f"Add {Path(op['path']).name}"
        elif kind == "delete":
            subject = f"Remove {Path(op['path']).name}"
        elif kind == "rename":
            subject = f"Rename {Path(op.get('old_path') or op['path']).name}"
        else:
            subject = f"Update {Path(op['path']).name}"
    else:
        subject = f"Update {len(ops)} files"
    body = [f"- {op['op']} {op['path']}" for op in ops]
    body.append(f"- seq {event['seq']} on {event['branch_ref']}")
    return subject + "\n\n" + "\n".join(body)


def load_pending_events(conn: sqlite3.Connection, branch_ref: str) -> List[sqlite3.Row]:
    return conn.execute(
        """SELECT seq, branch_ref, branch_generation, base_head, operation, path,
                  old_path, fidelity, captured_ts, state, commit_oid, error
           FROM capture_events
           WHERE branch_ref=? AND state='pending'
           ORDER BY seq""",
        (branch_ref,),
    ).fetchall()


def load_ops(conn: sqlite3.Connection, seq: int) -> List[sqlite3.Row]:
    return conn.execute(
        """SELECT ord, op, path, old_path, before_oid, before_mode, after_oid, after_mode, fidelity
           FROM capture_ops WHERE event_seq=? ORDER BY ord""",
        (seq,),
    ).fetchall()


def update_publish_state(
    conn: sqlite3.Connection,
    *,
    event_seq: Optional[int],
    branch_ref: str,
    branch_generation: int,
    source_head: str,
    target_commit_oid: Optional[str],
    status: str,
    error: Optional[str] = None,
) -> None:
    conn.execute(
        """INSERT INTO publish_state(id, event_seq, branch_ref, branch_generation,
               source_head, target_commit_oid, status, error, updated_ts)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
              event_seq=excluded.event_seq,
              branch_ref=excluded.branch_ref,
              branch_generation=excluded.branch_generation,
              source_head=excluded.source_head,
              target_commit_oid=excluded.target_commit_oid,
              status=excluded.status,
              error=excluded.error,
              updated_ts=excluded.updated_ts""",
        (event_seq, branch_ref, branch_generation, source_head, target_commit_oid, status, error, time.time()),
    )


def request_flush(conn: sqlite3.Connection, command: str, non_blocking: bool, note: str = "") -> int:
    cur = conn.execute(
        """INSERT INTO flush_requests(command, non_blocking, requested_ts, status, note)
           VALUES (?, ?, ?, 'pending', ?)""",
        (command, 1 if non_blocking else 0, time.time(), note),
    )
    return int(cur.lastrowid or 0)


def acknowledge_flush(
    conn: sqlite3.Connection,
    request_id: int,
    note: str = "",
    status: str = "acknowledged",
) -> None:
    """Mark a flush request acknowledged with an outcome status.

    ``status`` distinguishes successful acks ('acknowledged') from failure
    ('failed') so blocking controllers can return non-zero when the daemon
    raises during capture/replay rather than silently reporting ``ok=true``.
    Older callers that omit ``status`` continue to record the historical
    'acknowledged' value, keeping pre-existing rows backward compatible.
    """
    conn.execute(
        """UPDATE flush_requests SET acknowledged_ts=?, completed_ts=?, status=?, note=COALESCE(NULLIF(?, ''), note)
           WHERE id=?""",
        (time.time(), time.time(), status, note, request_id),
    )


_UNSET: Any = object()


def set_daemon_state(
    conn: sqlite3.Connection,
    *,
    pid: int,
    mode: str,
    branch_ref: Optional[str] = None,
    branch_generation: Optional[int] = None,
    note: str = "",
    daemon_token: Any = _UNSET,
    daemon_fingerprint: Any = _UNSET,
) -> None:
    """Update the singleton daemon_state row.

    ``daemon_token`` is an opaque identity token written by the daemon at
    startup; controllers must verify it before sending signals, so PID reuse
    by an unrelated process cannot be addressed by daemonctl commands.

    ``daemon_fingerprint`` is an OS-bound identity (process start time) that
    closes the residual PID-reuse window the bare token check left open: a
    recycled PID owned by a different process has a different start time.

    Both columns default to ``_UNSET`` meaning "preserve the existing value".
    Pass ``None`` to clear, or a string to replace. Type-checked to catch
    accidental misuse (booleans, ints) silently writing garbage.
    """
    if daemon_token is not _UNSET and daemon_token is not None and not isinstance(daemon_token, str):
        raise TypeError(f"daemon_token must be str or None, got {type(daemon_token).__name__}")
    if daemon_fingerprint is not _UNSET and daemon_fingerprint is not None and not isinstance(daemon_fingerprint, str):
        raise TypeError(
            f"daemon_fingerprint must be str or None, got {type(daemon_fingerprint).__name__}"
        )
    now = time.time()
    sets = ["pid=?", "mode=?", "heartbeat_ts=?", "branch_ref=?", "branch_generation=?", "note=?", "updated_ts=?"]
    params: List[Any] = [
        pid,
        mode,
        now,
        branch_ref,
        int(branch_generation) if branch_generation is not None else None,
        note,
        now,
    ]
    if daemon_token is not _UNSET:
        sets.append("daemon_token=?")
        params.append(daemon_token)
    if daemon_fingerprint is not _UNSET:
        sets.append("daemon_fingerprint=?")
        params.append(daemon_fingerprint)
    conn.execute(f"UPDATE daemon_state SET {', '.join(sets)} WHERE id=1", params)


def prune_expired(
    conn: sqlite3.Connection,
    *,
    retention_seconds: float,
    flush_retention_seconds: float = 86400.0,
) -> Dict[str, int]:
    """Trim acked flushes, terminal events, and stale shadow generations.

    Live state (pending events, unacked flushes) is left alone so an outage
    that left the daemon stopped does not eat user-visible queued work. All
    three deletes run inside a single ``BEGIN IMMEDIATE`` so a crash
    mid-prune leaves the table consistent (no orphan shadow rows pointing at
    a generation whose events were just deleted).

    Retention semantics: events are pruned by ``COALESCE(published_ts,
    captured_ts)``. A long-pending event published at the cutoff thus gets
    the full window from publish, not from capture.

    Stale ``shadow_paths`` rows for ``(branch_ref, branch_generation)``
    pairs with no remaining live or recent events are also dropped — without
    this, ``daemon.db`` grows by ~one full HEAD tree per rebase / hard
    checkout indefinitely.
    """
    now = time.time()
    flush_cutoff = now - max(0.0, flush_retention_seconds)
    event_cutoff = now - max(0.0, retention_seconds)
    with transaction(conn):
        flush_cur = conn.execute(
            "DELETE FROM flush_requests WHERE acknowledged_ts IS NOT NULL AND acknowledged_ts < ?",
            (flush_cutoff,),
        )
        event_cur = conn.execute(
            """DELETE FROM capture_events
               WHERE state IN ('published','failed','blocked_conflict')
                 AND COALESCE(published_ts, captured_ts) < ?""",
            (event_cutoff,),
        )
        # Drop shadow rows for branch generations that no longer have any live
        # events or shadow-anchor reasons to keep them. Keep the most recent
        # generation per branch so a freshly-stopped daemon can resume without
        # re-bootstrapping.
        shadow_cur = conn.execute(
            """DELETE FROM shadow_paths
               WHERE (branch_ref, branch_generation) NOT IN (
                   SELECT branch_ref, branch_generation FROM capture_events
                   WHERE state IN ('pending','publishing')
                   UNION
                   SELECT branch_ref, MAX(branch_generation) FROM shadow_paths
                   GROUP BY branch_ref
               )
                 AND updated_ts < ?""",
            (event_cutoff,),
        )
    return {
        "flush_requests": int(flush_cur.rowcount or 0),
        "capture_events": int(event_cur.rowcount or 0),
        "shadow_paths": int(shadow_cur.rowcount or 0),
    }


def mark_event_published(
    conn: sqlite3.Connection,
    *,
    seq: int,
    commit_oid: str,
    published_ts: Optional[float] = None,
) -> None:
    """Update a capture_event row when its publish completes.

    Centralizes the publish-time stamp so retention can use it.
    """
    conn.execute(
        """UPDATE capture_events
           SET state='published', commit_oid=?, error=NULL, published_ts=?
           WHERE seq=?""",
        (commit_oid, published_ts if published_ts is not None else time.time(), seq),
    )


def heartbeat_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError as exc:
        return exc.errno == errno.EPERM


def status_snapshot(conn: sqlite3.Connection, git_dir: Path) -> Dict[str, Any]:
    daemon = _row_to_dict(conn.execute("SELECT * FROM daemon_state WHERE id=1").fetchone())
    publish = _row_to_dict(conn.execute("SELECT * FROM publish_state WHERE id=1").fetchone())
    counts = {
        row[0]: int(row[1])
        for row in conn.execute(
            "SELECT state, COUNT(*) FROM capture_events GROUP BY state"
        ).fetchall()
    }
    return {
        "db": str(db_path(git_dir)),
        "daemon": daemon,
        "publish": publish,
        "counts": counts,
        "shadow_paths": int(conn.execute("SELECT COUNT(*) FROM shadow_paths").fetchone()[0]),
        "flush_requests": int(conn.execute("SELECT COUNT(*) FROM flush_requests").fetchone()[0]),
    }


@contextmanager
def control_lock(git_dir: Path) -> Iterator[None]:
    path = local_state_dir(git_dir) / CONTROL_LOCK_NAME
    ensure_state_dir(path.parent)
    with restricted_umask():
        fh = path.open("a+")
    restrict_file_perms(path)
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    finally:
        fh.close()


class PublishLockBusy(RuntimeError):
    """Raised when ``publish_lock`` cannot be acquired in the requested window."""


@contextmanager
def publish_lock(git_dir: Path, timeout: Optional[float] = None) -> Iterator[None]:
    """Acquire the publish flock, optionally bounded by ``timeout`` seconds.

    With ``timeout=None`` (the historical behavior) we block indefinitely.
    With a positive timeout we poll-acquire so a stalled sibling tool cannot
    permanently freeze the daemon's ack loop. Raises ``PublishLockBusy`` if
    the deadline expires.
    """
    path = local_state_dir(git_dir) / PUBLISH_LOCK_NAME
    ensure_state_dir(path.parent)
    with restricted_umask():
        fh = path.open("a+")
    restrict_file_perms(path)
    try:
        if timeout is None:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        else:
            deadline = time.time() + max(0.0, timeout)
            while True:
                try:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError as exc:
                    if exc.errno not in (errno.EAGAIN, errno.EACCES):
                        raise
                    if time.time() >= deadline:
                        raise PublishLockBusy(
                            f"publish_lock at {path} not acquired within {timeout}s"
                        ) from exc
                    time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    finally:
        fh.close()


def process_fingerprint(pid: Optional[int] = None) -> Optional[str]:
    """Cross-platform identity stamp for ``pid`` (defaults to the caller).

    Combines the OS-reported process start time with argv. PID reuse cannot
    reproduce the start time, so a recycled PID owned by an unrelated
    process will not match a stored fingerprint. Returns ``None`` if the
    process is not visible (already exited or permissions deny `ps`).
    """
    target_pid = os.getpid() if pid is None else int(pid)
    if target_pid <= 0:
        return None
    try:
        proc = subprocess.run(
            ["ps", "-p", str(target_pid), "-o", "lstart=,command="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=2.0,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.decode("utf-8", errors="replace").strip()
    return out or None


def verify_process_identity(pid: int, expected_fingerprint: Optional[str]) -> bool:
    """Return True if ``pid``'s current fingerprint matches ``expected_fingerprint``.

    A ``None`` ``expected_fingerprint`` means the daemon never recorded one
    (legacy state from before the fingerprint column existed) — we refuse
    rather than fall back to the unsafe pid-only check, so the user is
    forced to restart the daemon to upgrade safely.
    """
    if not expected_fingerprint:
        return False
    current = process_fingerprint(pid)
    if current is None:
        return False
    return current == expected_fingerprint


def capture_example_ops(
    repo_root: Path,
    *,
    path: str,
    text_before: Optional[str],
    text_after: Optional[str],
    old_path: Optional[str] = None,
    mode_before: str = "100644",
    mode_after: str = "100644",
    fidelity: str = "watcher",
) -> List[Dict[str, Any]]:
    before_oid = capture_blob_for_text(repo_root, text_before) if text_before is not None else None
    after_oid = capture_blob_for_text(repo_root, text_after) if text_after is not None else None
    kind = "modify"
    if text_before is None and text_after is not None:
        kind = "create"
    elif text_before is not None and text_after is None:
        kind = "delete"
    elif old_path:
        kind = "rename"
    return [
        {
            "op": kind,
            "path": path,
            "old_path": old_path,
            "before_oid": before_oid,
            "before_mode": mode_before if text_before is not None else None,
            "after_oid": after_oid,
            "after_mode": mode_after if text_after is not None else None,
            "fidelity": fidelity,
        }
    ]

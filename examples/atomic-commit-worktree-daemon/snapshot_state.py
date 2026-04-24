#!/usr/bin/env python3
"""Worktree-local state and replay helpers for the daemon example.

This is a conservative, runnable foundation for the example only. It keeps the
queue in a worktree-local SQLite DB, coordinates branch ownership through the
shared branch-registry pattern from ``snapshot_shared.py``, and quarantines
incompatible local state instead of trying to muddle through.
"""

from __future__ import annotations

import sys
import fcntl
import errno
import hashlib
import json
import os
import sqlite3
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
WORKER_DIR = HERE.parent / "atomic-commit-snapshot-worker"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from snapshot_shared import (  # type: ignore[reportMissingImports]
    IncompatibleLocalStateError,
    branch_worktree_git_dirs,
    current_head,
    ensure_branch_registry,
    local_state_dir,
    quarantine_incompatible_local_state,
    resolve_repo_paths as _resolve_repo_paths,
    run_git,
)


STATE_SUBDIR = "ai-snapshotd"
DB_NAME = "daemon.db"
LOCK_NAME = "daemon.lock"
CONTROL_LOCK_NAME = "control.lock"
INDEX_NAME = "worker.index"
SCHEMA_VERSION = 1


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
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA user_version")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS daemon_state(
               id INTEGER PRIMARY KEY CHECK (id = 1),
               pid INTEGER NOT NULL DEFAULT 0,
               mode TEXT NOT NULL DEFAULT 'stopped',
               heartbeat_ts REAL NOT NULL DEFAULT 0,
               branch_ref TEXT,
               branch_generation INTEGER,
               note TEXT,
               updated_ts REAL NOT NULL
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS shadow_paths(
               path TEXT PRIMARY KEY,
               operation TEXT NOT NULL,
               mode TEXT,
               oid TEXT,
               old_path TEXT,
               branch_ref TEXT NOT NULL,
               branch_generation INTEGER NOT NULL,
               base_head TEXT NOT NULL,
               fidelity TEXT NOT NULL,
               updated_ts REAL NOT NULL
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
               request_token TEXT NOT NULL,
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
    conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")


def open_state(git_dir: Path, allow_reset: bool = True) -> sqlite3.Connection:
    try:
        conn = _connect(git_dir)
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if version not in (0, SCHEMA_VERSION):
            raise IncompatibleLocalStateError(f"daemon DB user_version={version}")
        _ensure_schema(conn)
        return conn
    except IncompatibleLocalStateError:
        raise
    except Exception:
        raise


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


def load_shadow_paths(conn: sqlite3.Connection) -> Dict[str, Dict[str, Any]]:
    return {
        row["path"]: dict(row)
        for row in conn.execute(
            "SELECT path, operation, mode, oid, old_path, branch_ref, branch_generation, base_head, fidelity, updated_ts FROM shadow_paths"
        ).fetchall()
    }


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
    conn.execute("DELETE FROM shadow_paths")
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


def repo_context(repo_input: Path, explicit_git_dir: Optional[Path] = None) -> Dict[str, Any]:
    repo_root, git_dir, common_dir = resolve_repo_paths(repo_input)
    if explicit_git_dir is not None:
        git_dir = explicit_git_dir.resolve()
    branch = current_branch(repo_root)
    head = current_head(repo_root)
    if branch is None:
        raise RuntimeError("detached or unborn HEAD is not replay-safe")
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


def _hash_blob(repo_root: Path, data: bytes) -> str:
    proc = subprocess.run(
        ["git", "hash-object", "-w", "--stdin"],
        cwd=str(repo_root),
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
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
        conn.execute("DELETE FROM shadow_paths WHERE path=?", (op["path"],))
        return
    if op["op"] == "rename" and op.get("old_path"):
        conn.execute("DELETE FROM shadow_paths WHERE path=?", (op["old_path"],))
    conn.execute(
        """INSERT INTO shadow_paths(path, operation, mode, oid, old_path,
               branch_ref, branch_generation, base_head, fidelity, updated_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
              operation=excluded.operation,
              mode=excluded.mode,
              oid=excluded.oid,
              old_path=excluded.old_path,
              branch_ref=excluded.branch_ref,
              branch_generation=excluded.branch_generation,
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


def capture_blob_for_text(repo_root: Path, text: str) -> str:
    return _hash_blob(repo_root, text.encode("utf-8"))


def capture_blob_for_bytes(repo_root: Path, data: bytes) -> str:
    return _hash_blob(repo_root, data)


def current_branch(repo_root: Path) -> Optional[str]:
    proc = subprocess.run(
        ["git", "symbolic-ref", "-q", "HEAD"],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        return None
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
        state[path_bytes.decode("utf-8", errors="replace")] = (
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
            mode = op.get("after_mode") or op.get("before_mode") or "100644"
            oid = op.get("after_oid") or op.get("before_oid") or zero_oid
            lines.append(f"{mode} {oid}\t{op['path']}".encode("utf-8"))
        elif kind == "delete":
            lines.append(f"0 {zero_oid}\t{op['path']}".encode("utf-8"))
        elif kind == "rename":
            if op.get("old_path"):
                lines.append(f"0 {zero_oid}\t{op['old_path']}".encode("utf-8"))
            lines.append(
                f"{op.get('after_mode') or '100644'} {op.get('after_oid') or zero_oid}\t{op['path']}".encode(
                    "utf-8"
                )
            )
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
    token = hashlib.sha256(f"{command}:{time.time_ns()}:{os.getpid()}".encode()).hexdigest()[:16]
    cur = conn.execute(
        """INSERT INTO flush_requests(request_token, command, non_blocking, requested_ts, status, note)
           VALUES (?, ?, ?, ?, 'pending', ?)""",
        (token, command, 1 if non_blocking else 0, time.time(), note),
    )
    return int(cur.lastrowid or 0)


def acknowledge_flush(conn: sqlite3.Connection, request_id: int, note: str = "") -> None:
    conn.execute(
        """UPDATE flush_requests SET acknowledged_ts=?, completed_ts=?, status='acknowledged', note=COALESCE(NULLIF(?, ''), note)
           WHERE id=?""",
        (time.time(), time.time(), note, request_id),
    )


def set_daemon_state(
    conn: sqlite3.Connection,
    *,
    pid: int,
    mode: str,
    branch_ref: Optional[str] = None,
    branch_generation: Optional[int] = None,
    note: str = "",
) -> None:
    conn.execute(
        """UPDATE daemon_state SET pid=?, mode=?, heartbeat_ts=?, branch_ref=?,
               branch_generation=?, note=?, updated_ts=? WHERE id=1""",
        (
            pid,
            mode,
            time.time(),
            branch_ref,
            int(branch_generation) if branch_generation is not None else None,
            note,
            time.time(),
        ),
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
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


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

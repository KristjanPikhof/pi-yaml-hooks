#!/usr/bin/env python3
"""Portable capture backend for the worktree daemon example.

The first implementation uses polling/rescan only. It seeds a shadow tree on
startup, compares the live worktree against the stored shadow on each poll, and
records stable file events with ``rescan`` fidelity.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import stat
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import snapshot_state  # noqa: E402
from snapshot_shared import git_bin  # noqa: E402


IGNORE_NAMES = {".git", snapshot_state.STATE_SUBDIR}
# Canonical default list lives in snapshot_state.DEFAULT_SENSITIVE_GLOBS so the
# fast-path filter here and the defence-in-depth guard inside capture_blob_*
# can never drift. SNAPSHOTD_SENSITIVE_GLOBS overrides at runtime.

# Default ceiling for bytes hashed from a single regular file. A worktree may
# legitimately contain large generated artefacts (videos, datasets, build
# outputs) but accumulating them into one Python ``bytes`` and feeding the
# whole thing to ``git hash-object -w --stdin`` is a memory-blow-up risk —
# we read the whole blob into RAM before handing it off. The default mirrors
# git's own ``core.bigFileThreshold`` neighbourhood while staying conservative
# for daemon use; operators can override via ``SNAPSHOTD_MAX_FILE_BYTES``.
_DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024


class _LargeFileSkipped(RuntimeError):
    """Raised when a regular file exceeds the configured size cap.

    Carries the on-disk size at the time of the check so callers can record
    a daemon_meta entry that is more useful than just the path.
    """

    def __init__(self, size: int, cap: int) -> None:
        super().__init__(f"file size {size} exceeds cap {cap}")
        self.size = size
        self.cap = cap


def _max_file_bytes() -> int:
    """Resolve the per-file size ceiling from env (defaults to 100MB).

    A non-positive or unparseable override falls back to the default rather
    than disabling the guard — an operator who wants no cap should set a
    very large positive number, not ``0``.
    """
    raw = os.environ.get("SNAPSHOTD_MAX_FILE_BYTES")
    if raw is None:
        return _DEFAULT_MAX_FILE_BYTES
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_MAX_FILE_BYTES
    if value <= 0:
        return _DEFAULT_MAX_FILE_BYTES
    return value


def _mode_for_stat(st: os.stat_result) -> str:
    if stat.S_ISLNK(st.st_mode):
        return "120000"
    if st.st_mode & stat.S_IXUSR:
        return "100755"
    return "100644"


class _IgnoreCheckFailed(RuntimeError):
    """Raised when ``git check-ignore`` errors so callers can fail closed."""


def _validated_symlink_target_bytes(path: Path, repo_root: Path) -> Optional[bytes]:
    """Read the symlink target *once* and validate the same bytes we will store.

    Per git's symlink convention, a symlink's blob content IS the literal
    link target. The sensitive-path filter only sees the *path*, not the
    target, so we additionally reject targets that match sensitive globs
    or escape the worktree root.

    Closes the readlink TOCTOU: a previous version of this code called
    ``os.readlink`` once for validation and a second time for storage, which
    let an attacker flip the symlink between the two reads (validate a
    benign target, hash a malicious one). We call ``os.readlink`` exactly
    once and thread the resulting bytes through both validation and storage
    so the validated value is the stored value.

    Returns ``None`` if the target is unsafe or unreadable.
    """
    try:
        raw_target = os.readlink(path)
    except OSError:
        return None
    if os.path.isabs(raw_target):
        absolute = Path(raw_target)
    else:
        absolute = (path.parent / raw_target)
    try:
        resolved = absolute.resolve()
    except OSError:
        return None
    try:
        rel_to_repo = resolved.relative_to(repo_root.resolve())
    except ValueError:
        # Target escapes the worktree — never write it as a blob.
        return None
    if snapshot_state.is_sensitive_path(rel_to_repo.as_posix()):
        return None
    return raw_target.encode("utf-8")


def _open_regular_file_safely(
    path: Path, expected_st: os.stat_result, repo_root: Path
) -> Optional[bytes]:
    """Read a regular file with O_NOFOLLOW and verify it didn't change.

    Closes the TOCTOU between our `lstat()` (which classified the path as a
    benign regular file) and `read()`: if the file got swapped for a
    symlink in between, ``O_NOFOLLOW`` rejects it; if the inode/device
    changed, we discard the read so a freshly-replaced file isn't hashed
    under the prior path classification. Returns ``None`` to skip the file.

    Enforces the configured per-file size ceiling against the post-open
    ``fstat()`` size so a file that grew between ``lstat()`` and ``open()``
    still cannot blow up the daemon's memory. ``_LargeFileSkipped`` is
    raised on cap-exceeded so the caller can record an explicit skip
    (rather than silently treating the file as unreadable).
    """
    flags = os.O_RDONLY
    flags |= getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None
    try:
        try:
            actual = os.fstat(fd)
        except OSError:
            return None
        if (
            actual.st_dev != expected_st.st_dev
            or actual.st_ino != expected_st.st_ino
            or stat.S_IFMT(actual.st_mode) != stat.S_IFREG
        ):
            return None
        cap = _max_file_bytes()
        if int(actual.st_size) > cap:
            raise _LargeFileSkipped(int(actual.st_size), cap)
        chunks: List[bytes] = []
        while True:
            try:
                chunk = os.read(fd, 1 << 20)
            except OSError:
                return None
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _is_git_ignored(repo_root: Path, rel: str) -> bool:
    """Single-path fallback. Prefer ``_batch_check_ignored`` inside _scan_tree."""
    proc = subprocess.run(
        [git_bin(), "check-ignore", "-q", "--", rel],
        cwd=str(repo_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=snapshot_state._clean_git_env(),
    )
    return proc.returncode == 0


def _batch_check_ignored(repo_root: Path, paths: List[str]) -> set[str]:
    """Return the subset of ``paths`` that git considers ignored.

    One subprocess for the whole tick beats N subprocesses on a 5k-file repo.
    Fails *closed*: a non-zero/non-one exit (broken patterns, permissions,
    repository state error) raises ``_IgnoreCheckFailed`` so the caller can
    abort the poll cycle rather than letting the boundary fail open and
    accidentally hash files that should have been ignored.
    """
    if not paths:
        return set()
    payload = ("\x00".join(paths) + "\x00").encode("utf-8")
    proc = subprocess.run(
        [git_bin(), "check-ignore", "--stdin", "-z"],
        cwd=str(repo_root),
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=snapshot_state._clean_git_env(),
    )
    # exit 0 = some matched; exit 1 = none matched; >1 = real error.
    if proc.returncode > 1:
        raise _IgnoreCheckFailed(
            proc.stderr.decode("utf-8", errors="replace").strip()
            or f"git check-ignore exited {proc.returncode}"
        )
    ignored: set[str] = set()
    for chunk in proc.stdout.split(b"\x00"):
        if not chunk:
            continue
        ignored.add(chunk.decode("utf-8", errors="replace"))
    return ignored


def _is_sensitive(rel: str) -> bool:
    return snapshot_state.is_sensitive_path(rel)


# Stat-signature cache. Keyed by `(repo_root, branch_ref, branch_generation)`
# so a branch swap or generation bump invalidates the cache: a same-
# (size, mtime_ns) file whose contents differ across branches cannot reuse a
# stale OID from the prior branch.
#
# We hold *at most one* entry per repo at any time. Without the eviction
# step in ``_evict_stale_cache_keys`` this dict would grow unboundedly across
# branch swaps and rebases (every new generation adds a key, the prior key
# never falls out), wedging a long-running daemon's RSS open. The active
# (branch, generation) entry is the only one a same-tick scan would hit, so
# discarding the rest is safe.
_STAT_CACHE: Dict[Tuple[str, str, int], Dict[str, Tuple[int, int, int, int, str]]] = {}


def _cache_key(repo_root: Path, branch_ref: str, branch_generation: int) -> Tuple[str, str, int]:
    return (str(repo_root), branch_ref, int(branch_generation))


def _evict_stale_cache_keys(active_key: Tuple[str, str, int]) -> None:
    """Drop every cache entry for ``active_key``'s repo other than itself.

    Called on each scan so a branch swap or generation bump does not leave
    the prior entry resident forever. The active key may not yet exist in
    the dict (first scan after eviction) — that's fine, the next
    ``setdefault`` will populate it.
    """
    repo_root_str = active_key[0]
    stale = [
        key
        for key in list(_STAT_CACHE.keys())
        if key[0] == repo_root_str and key != active_key
    ]
    for key in stale:
        _STAT_CACHE.pop(key, None)


def _is_under_nested_repo(root_path: Path, name: str) -> bool:
    """A nested repo or submodule is signaled by ``.git`` (file or dir).

    Modern submodules use a ``.git`` *file* (a gitlink pointing at
    ``../../.git/modules/...``), older / unusual layouts use a directory.
    Either way, descending into them and capturing their working files would
    overwrite the parent's gitlink with submodule internals on the next
    classify pass.
    """
    return (root_path / name / ".git").exists()


def _scan_tree(
    repo_root: Path,
    *,
    branch_ref: str,
    branch_generation: int,
    head_baseline: Optional[Dict[str, Dict[str, Any]]] = None,
    conn: Optional[Any] = None,
) -> Dict[str, Dict[str, Any]]:
    entries: Dict[str, Dict[str, Any]] = {}
    active_key = _cache_key(repo_root, branch_ref, branch_generation)
    # Drop any other (branch, generation) cache entries for this repo before
    # we install / reuse the active one, so the cache cannot accumulate one
    # entry per branch swap or generation bump for the lifetime of the
    # process.
    _evict_stale_cache_keys(active_key)
    cache = _STAT_CACHE.setdefault(active_key, {})
    next_cache: Dict[str, Tuple[int, int, int, int, str]] = {}
    pending_files: List[Tuple[str, Path, os.stat_result]] = []
    candidate_rels: List[str] = []
    submodule_paths = {
        rel.split("/", 1)[0]
        for rel, meta in (head_baseline or {}).items()
        if str(meta.get("mode")) == "160000"
    }

    for root, dirs, files in os.walk(repo_root, topdown=True, followlinks=False):
        root_path = Path(root)
        try:
            rel_root = root_path.relative_to(repo_root).as_posix()
        except ValueError:
            rel_root = ""
        # Prune ignored dirs, our own state dir, AND any nested repo /
        # submodule directory (it has its own .git pointer). Walking into a
        # submodule and hashing its files would corrupt the parent history.
        #
        # ``os.walk(followlinks=False)`` classifies entries by *target* type:
        # a symlink whose target is a directory lands in ``dirs`` (and is not
        # descended into), not in ``files``. If we let those pass through the
        # dir-pruning loop without recording them, ``live`` will be missing
        # every dir-symlink the repo tracks, and ``_classify_changes`` will
        # emit a spurious ``delete`` event on every tick — which the replay
        # lane then commits as ``Remove <name>``. Detect dir-symlinks here
        # and route them to ``pending_files`` as ordinary symlink entries.
        kept_dirs: List[str] = []
        for name in dirs:
            if name in IGNORE_NAMES:
                continue
            sub_rel = f"{rel_root}/{name}".lstrip("/")
            if sub_rel in submodule_paths:
                continue
            full = root_path / name
            try:
                dir_st = full.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(dir_st.st_mode):
                rel = full.relative_to(repo_root).as_posix()
                if not _is_sensitive(rel):
                    pending_files.append((rel, full, dir_st))
                    candidate_rels.append(rel)
                continue
            if _is_under_nested_repo(root_path, name):
                continue
            kept_dirs.append(name)
        dirs[:] = kept_dirs

        for name in files:
            if name in IGNORE_NAMES:
                continue
            path = root_path / name
            try:
                st = path.lstat()
            except FileNotFoundError:
                continue
            # Skip anything that isn't a regular file or a symlink. Sockets,
            # FIFOs, block/char devices would either block on read or persist
            # garbage into the object store.
            if not (stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode)):
                continue
            rel = path.relative_to(repo_root).as_posix()
            if _is_sensitive(rel):
                continue
            pending_files.append((rel, path, st))
            candidate_rels.append(rel)

    ignored = _batch_check_ignored(repo_root, candidate_rels)

    for rel, path, st in pending_files:
        if rel in ignored:
            continue
        # Cache key includes inode and ctime_ns so that timestamp-preserving
        # tools (cp -p, rsync -a, untar) can't fool us into reusing a stale
        # OID — ctime changes on any metadata mutation, ino changes on
        # rename/replace.
        sig = (
            int(st.st_size),
            int(st.st_mtime_ns),
            int(st.st_ctime_ns),
            int(st.st_ino),
        )
        prev = cache.get(rel)
        if prev is not None and prev[:4] == sig:
            # Same (size, mtime_ns, ctime_ns, ino) as last tick — reuse the
            # cached OID without re-running `git hash-object -w`.
            oid = prev[4]
        else:
            # New file or changed signature. Polling-fidelity capture cannot
            # prove a file is past its final flush — a streaming write may
            # produce intermediate hashed states. The README documents this
            # as a known limitation; the rescan classifier will produce a
            # follow-up `modify` event when the file stabilizes, so the
            # final committed state is correct even if intermediate ones
            # are recorded.
            try:
                if stat.S_ISLNK(st.st_mode):
                    # Read once, validate the same bytes we will store.
                    target = _validated_symlink_target_bytes(path, repo_root)
                    if target is None:
                        continue
                    data = target
                else:
                    try:
                        data = _open_regular_file_safely(path, st, repo_root)
                    except _LargeFileSkipped as skipped:
                        if conn is not None:
                            try:
                                snapshot_state.set_daemon_meta(
                                    conn,
                                    f"capture-skip-large:{rel}",
                                    f"size={skipped.size}>cap={skipped.cap}",
                                )
                            except Exception:
                                pass
                        continue
                    if data is None:
                        continue
            except FileNotFoundError:
                continue
            try:
                oid = snapshot_state.capture_blob_for_bytes(repo_root, data, rel_path=rel)
            except snapshot_state.SensitivePathRefused:
                continue
        next_cache[rel] = (sig[0], sig[1], sig[2], sig[3], oid)
        entries[rel] = {
            "path": rel,
            "mode": _mode_for_stat(st),
            "oid": oid,
        }

    _STAT_CACHE[active_key] = next_cache
    return entries


def _bootstrap_meta_key(branch_ref: str, branch_generation: int) -> str:
    return f"shadow_bootstrapped:{branch_ref}:{branch_generation}"


class _HeadTreeReadFailed(RuntimeError):
    """Raised when ``git ls-tree`` fails so callers can leave shadow state alone.

    The previous behaviour swallowed the error and returned an empty dict,
    which let ``bootstrap_shadow`` overwrite the real shadow map with an
    empty baseline and stamp the bootstrap marker — every file in the
    worktree then re-classified as ``create`` on the next poll. Surfacing
    the failure as an exception lets callers leave both the shadow and the
    marker untouched so the next attempt can recover.
    """


def _head_tree_entries(
    repo_root: Path, head: str, conn: Optional[Any] = None
) -> Dict[str, Dict[str, Any]]:
    """Return {rel: {path, mode, oid}} from `git ls-tree -r` at ``head``.

    Using the HEAD tree as baseline means the first modify recorded by the
    daemon describes a diff against what git already committed — not against
    whatever dirty state the worktree happened to have at bootstrap.

    Submodule entries (mode 160000) are kept in the result so the scanner
    can prune them from worktree traversal — but they carry no oid we can
    feed into the index against the parent repo, so callers should not feed
    them through `_classify_changes` as ordinary files.

    Failures are recorded via ``daemon_meta.last_bootstrap_error`` (when a
    ``conn`` is provided) AND surfaced as ``_HeadTreeReadFailed`` so a
    silent empty bootstrap can't reclassify every file as ``create`` on the
    first poll.
    """
    if not head:
        return {}
    proc = subprocess.run(
        [git_bin(), "ls-tree", "-r", "-z", head],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=snapshot_state._clean_git_env(),
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        message = err or f"git ls-tree exited {proc.returncode}"
        if conn is not None:
            try:
                snapshot_state.set_daemon_meta(
                    conn,
                    "last_bootstrap_error",
                    message,
                )
            except Exception:
                pass
        raise _HeadTreeReadFailed(message)
    entries: Dict[str, Dict[str, Any]] = {}
    for chunk in proc.stdout.split(b"\x00"):
        if not chunk:
            continue
        meta, _tab, path_bytes = chunk.partition(b"\t")
        parts = meta.split()
        if len(parts) < 3:
            continue
        mode = parts[0].decode()
        oid = parts[2].decode()
        rel = os.fsdecode(path_bytes)
        if rel in IGNORE_NAMES or rel.startswith(".git/"):
            continue
        if _is_sensitive(rel):
            continue
        entries[rel] = {"path": rel, "mode": mode, "oid": oid}
    if conn is not None:
        try:
            snapshot_state.set_daemon_meta(conn, "last_bootstrap_error", "")
        except Exception:
            pass
    return entries


def bootstrap_shadow(
    conn,
    repo_root: Path,
    *,
    branch_ref: str,
    branch_generation: int,
    base_head: str,
) -> int:
    """Seed the shadow map against HEAD for this (branch, generation).

    Shadow state is keyed by (branch_ref, branch_generation). When the daemon
    is bounced across a branch switch, the prior branch's row stays put and
    this branch's row is either reused (already bootstrapped) or rebuilt.
    Submodule (gitlink) entries are recorded so the scanner can skip them but
    are filtered out of the working-tree shadow map fed to ``_classify_changes``
    — replaying a gitlink's contents as ordinary file blobs corrupts history.
    """
    marker = _bootstrap_meta_key(branch_ref, branch_generation)
    stored_head = snapshot_state.get_daemon_meta(conn, marker)
    if stored_head == base_head:
        return 0

    # If ``git ls-tree`` fails we MUST NOT proceed: the previous code path
    # let an empty entries dict flow into ``replace_shadow_paths`` and
    # stamped the bootstrap marker, which on next poll classified every
    # tracked file as a fresh ``create`` (a flood of spurious events that
    # then got committed). Leave shadow + marker untouched and propagate
    # the failure; the daemon main loop will retry on the next tick.
    entries = _head_tree_entries(repo_root, base_head, conn=conn)
    file_entries = {
        rel: meta for rel, meta in entries.items() if str(meta.get("mode")) != "160000"
    }
    snapshot_state.replace_shadow_paths(
        conn,
        branch_ref=branch_ref,
        branch_generation=branch_generation,
        base_head=base_head,
        entries=(
            {
                "path": row["path"],
                "operation": "baseline",
                "mode": row["mode"],
                "oid": row["oid"],
                "fidelity": "rescan",
            }
            for row in file_entries.values()
        ),
    )
    # Only set the marker AFTER the shadow rewrite succeeded so a partial
    # failure cannot leave a stamped-but-empty baseline behind.
    snapshot_state.set_daemon_meta(conn, marker, base_head)
    return len(file_entries)


def _head_tree_with_submodules(repo_root: Path, head: str, conn) -> Dict[str, Dict[str, Any]]:
    return _head_tree_entries(repo_root, head, conn=conn)


def _shadow_map(
    conn,
    *,
    branch_ref: str,
    branch_generation: int,
) -> Dict[str, Dict[str, Any]]:
    return snapshot_state.load_shadow_paths(
        conn,
        branch_ref=branch_ref,
        branch_generation=branch_generation,
    )


def _classify_changes(
    shadow: Dict[str, Dict[str, Any]],
    live: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    deletes = [shadow[path] for path in shadow.keys() - live.keys()]
    creates = [live[path] for path in live.keys() - shadow.keys()]
    updates: List[Dict[str, Any]] = []

    paired_creates: set[str] = set()
    paired_deletes: set[str] = set()
    create_by_sig: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for entry in creates:
        create_by_sig.setdefault((entry["oid"], entry["mode"]), []).append(entry)

    for old in deletes:
        sig = (old.get("oid") or "", old.get("mode") or "")
        matches = create_by_sig.get(sig, [])
        if len(matches) == 1 and matches[0]["path"] not in paired_creates:
            new = matches[0]
            paired_creates.add(new["path"])
            paired_deletes.add(old["path"])
            updates.append(
                {
                    "op": "rename",
                    "path": new["path"],
                    "old_path": old["path"],
                    "before_oid": old.get("oid"),
                    "before_mode": old.get("mode"),
                    "after_oid": new.get("oid"),
                    "after_mode": new.get("mode"),
                    "fidelity": "rescan",
                }
            )

    for path, live_entry in sorted(live.items()):
        shadow_entry = shadow.get(path)
        if shadow_entry is None:
            if path not in paired_creates:
                updates.append(
                    {
                        "op": "create",
                        "path": path,
                        "before_oid": None,
                        "before_mode": None,
                        "after_oid": live_entry["oid"],
                        "after_mode": live_entry["mode"],
                        "fidelity": "rescan",
                    }
                )
            continue
        if shadow_entry.get("oid") != live_entry.get("oid"):
            updates.append(
                {
                    "op": "modify",
                    "path": path,
                    "before_oid": shadow_entry.get("oid"),
                    "before_mode": shadow_entry.get("mode"),
                    "after_oid": live_entry.get("oid"),
                    "after_mode": live_entry.get("mode"),
                    "fidelity": "rescan",
                }
            )
        elif shadow_entry.get("mode") != live_entry.get("mode"):
            updates.append(
                {
                    "op": "mode",
                    "path": path,
                    "before_oid": shadow_entry.get("oid"),
                    "before_mode": shadow_entry.get("mode"),
                    "after_oid": live_entry.get("oid"),
                    "after_mode": live_entry.get("mode"),
                    "fidelity": "rescan",
                }
            )

    for old in sorted(deletes, key=lambda row: row["path"]):
        if old["path"] in paired_deletes:
            continue
        updates.append(
            {
                "op": "delete",
                "path": old["path"],
                "before_oid": old.get("oid"),
                "before_mode": old.get("mode"),
                "after_oid": None,
                "after_mode": None,
                "fidelity": "rescan",
            }
        )

    return updates


def _apply_event(conn, ctx: Dict[str, Any], event: Dict[str, Any]) -> int:
    return snapshot_state.record_event(
        conn,
        branch_ref=ctx["branch_ref"],
        branch_generation=ctx["branch_generation"],
        base_head=ctx["base_head"],
        operation=event["op"],
        path=event["path"],
        old_path=event.get("old_path"),
        fidelity=event.get("fidelity", "rescan"),
        ops=[event],
    )


def poll_once(conn, repo_root: Path, git_dir: Path) -> List[int]:
    ctx = snapshot_state.repo_context(repo_root, git_dir)
    try:
        bootstrap_shadow(
            conn,
            repo_root,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            base_head=ctx["base_head"],
        )
    except _HeadTreeReadFailed as exc:
        # ``git ls-tree`` failed before we had a usable baseline. Leaving
        # the shadow + marker untouched is the whole point of raising —
        # we've already recorded ``last_bootstrap_error`` from inside
        # ``_head_tree_entries``; just bail without emitting events.
        snapshot_state.set_daemon_meta(conn, "last_capture_error", f"bootstrap: {exc}")
        return []
    shadow = _shadow_map(
        conn,
        branch_ref=ctx["branch_ref"],
        branch_generation=ctx["branch_generation"],
    )
    try:
        head_baseline = _head_tree_with_submodules(repo_root, ctx["base_head"], conn)
    except _HeadTreeReadFailed as exc:
        snapshot_state.set_daemon_meta(conn, "last_capture_error", f"head-baseline: {exc}")
        return []
    try:
        live = _scan_tree(
            repo_root,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            head_baseline=head_baseline,
            conn=conn,
        )
    except _IgnoreCheckFailed as exc:
        # Fail closed: a broken `git check-ignore` invocation must NOT cause
        # us to silently treat ignored files as un-ignored. Record the
        # error, leave shadow untouched, and emit no events for this tick.
        snapshot_state.set_daemon_meta(conn, "last_capture_error", f"check-ignore: {exc}")
        return []
    events = _classify_changes(shadow, live)
    seqs: List[int] = []
    for event in events:
        seqs.append(_apply_event(conn, ctx, event))
    return seqs


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Poll the worktree and record rescan events")
    parser.add_argument("--repo", default=os.getcwd(), help="repo working directory")
    parser.add_argument("--git-dir", help="explicit git dir override")
    parser.add_argument("--once", action="store_true", help="perform one rescan and exit")
    args = parser.parse_args(argv)

    repo_input = Path(args.repo).expanduser()
    try:
        repo_root, git_dir, _common = snapshot_state.resolve_repo_paths(repo_input)
        if args.git_dir:
            git_dir = Path(args.git_dir).expanduser().resolve()
    except Exception as exc:
        print(f"not a git repository: {exc}", file=sys.stderr)
        return 1

    conn = snapshot_state.ensure_state(git_dir)
    try:
        if args.once:
            try:
                published = poll_once(conn, repo_root, git_dir)
            except _IgnoreCheckFailed as exc:
                print(f"check-ignore failed: {exc}", file=sys.stderr)
                return 1
            print(json.dumps({"published": published}, sort_keys=True))
            return 0
        ctx = snapshot_state.repo_context(repo_root, git_dir)
        try:
            scanned = bootstrap_shadow(
                conn,
                repo_root,
                branch_ref=ctx["branch_ref"],
                branch_generation=ctx["branch_generation"],
                base_head=ctx["base_head"],
            )
        except _HeadTreeReadFailed as exc:
            print(f"bootstrap failed: {exc}", file=sys.stderr)
            return 1
        print(json.dumps({"scanned": scanned}, sort_keys=True))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

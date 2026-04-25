#!/usr/bin/env python3
"""Replay captured snapshot events into real git commits.

The replay path is deliberately conservative: it loads a worktree-local SQLite
queue, validates branch ownership through the shared registry helper, creates
one commit per captured event by default, and publishes the result with a
compare-and-swap ``git update-ref``.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shlex
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple
from urllib import error as urllib_error
from urllib import request as urllib_request

from snapshot_state import (
    _clean_git_env,
    apply_ops_to_index,
    build_message,
    ensure_state,
    index_path,
    load_ops,
    load_pending_events,
    mark_event_published,
    publish_lock,
    PublishLockBusy,
    repo_context,
    resolve_repo_paths,
    set_daemon_meta,
    snapshot_state_for_index,
    status_snapshot,
    update_publish_state,
)


REPLAY_PUBLISH_LOCK_TIMEOUT = float(os.environ.get("SNAPSHOTD_PUBLISH_LOCK_TIMEOUT", "30.0"))


def _replay_batch_max() -> int:
    """How many events the replay loop will process per ``publish_lock`` acquisition.

    Bounded so a deep backlog does not monopolize the lock for the entire
    drain — sibling tools and the daemon's flush ackers need a chance to
    take the lock between batches. ``SNAPSHOTD_REPLAY_BATCH_MAX`` overrides
    the default of 200; non-positive or unparseable values fall back to it.
    """
    raw = os.environ.get("SNAPSHOTD_REPLAY_BATCH_MAX")
    if raw is None:
        return 200
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 200
    if value <= 0:
        return 200
    return value


ABSENT: Tuple[str, str] = ("__absent__", "__absent__")


class GitObjectMissing(RuntimeError):
    """Raised when ``git merge-base --is-ancestor`` cannot resolve an OID.

    Distinct from "the OID is not an ancestor": the latter is a routine
    blocked_conflict, while this represents a corrupt or pruned object
    store and must be surfaced as a real failure mode in ``daemon_meta``.
    """


def _is_ancestor(repo_root: Path, ancestor: str, descendant: str) -> bool:
    """Return True if ``ancestor`` is reachable from ``descendant``.

    git documents two well-defined exit statuses for this command: 0 means
    ancestor, 1 means not-ancestor. Any other status is an actual error
    (typically a missing object, which prints "Not a valid commit name"
    and exits 128). Treating those as "not ancestor" silently masked
    object-store corruption as a generic ``blocked_conflict``; raise
    instead so callers can record the real failure.
    """
    proc = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
    )
    if proc.returncode == 0:
        return True
    if proc.returncode == 1:
        return False
    stderr_text = proc.stderr.decode("utf-8", errors="replace").strip()
    raise GitObjectMissing(
        stderr_text or f"git merge-base --is-ancestor exited {proc.returncode}"
    )


def _validate_op(op: Dict[str, Any]) -> Optional[str]:
    """Reject malformed ops before they touch the index.

    After-fields must be set for any op that writes content. Missing values
    historically fell through to a zero-OID placeholder which corrupted the
    index; refuse them explicitly instead.
    """
    kind = op.get("op")
    path = op.get("path")
    if not path:
        return f"missing path for op {kind!r}"
    if kind in {"create", "modify", "mode", "symlink", "rename"}:
        if not op.get("after_oid"):
            return f"missing after_oid for {kind} {path}"
        if not op.get("after_mode"):
            return f"missing after_mode for {kind} {path}"
    if kind in {"modify", "mode", "symlink", "delete"}:
        if not op.get("before_oid"):
            return f"missing before_oid for {kind} {path}"
        if not op.get("before_mode"):
            return f"missing before_mode for {kind} {path}"
    if kind == "rename":
        if not op.get("old_path"):
            return f"missing old_path for rename {path}"
        if not op.get("before_oid"):
            return f"missing before_oid for rename {path}"
        if not op.get("before_mode"):
            return f"missing before_mode for rename {path}"
    return None


def _verify_op(op: Dict[str, Any], state: Dict[str, Tuple[str, str]]) -> Optional[str]:
    kind = op["op"]
    path = op["path"]
    if kind == "create":
        if path in state and state[path] != (op.get("after_mode"), op.get("after_oid")):
            return f"create conflict for {path}"
        return None
    if kind in {"modify", "mode", "symlink"}:
        before = (op.get("before_mode"), op.get("before_oid"))
        if state.get(path) != before:
            return f"{kind} before-state mismatch for {path}"
        return None
    if kind == "delete":
        before = (op.get("before_mode"), op.get("before_oid"))
        if state.get(path) != before:
            return f"delete before-state mismatch for {path}"
        return None
    if kind == "rename":
        old_path = op.get("old_path") or ""
        before = (op.get("before_mode"), op.get("before_oid"))
        if state.get(old_path) != before:
            return f"rename source mismatch for {old_path}"
        if path in state:
            return f"rename target already exists for {path}"
        return None
    return f"unknown op: {kind}"


def _apply_state(op: Dict[str, Any], state: Dict[str, Tuple[str, str]]) -> None:
    kind = op["op"]
    path = op["path"]
    if kind in {"create", "modify", "mode", "symlink"}:
        state[path] = (op["after_mode"], op["after_oid"])
    elif kind == "delete":
        state.pop(path, None)
    elif kind == "rename":
        old_path = op.get("old_path") or ""
        if old_path:
            state.pop(old_path, None)
        state[path] = (op["after_mode"], op["after_oid"])


def _touched_paths(ops: List[Dict[str, Any]]) -> List[str]:
    paths: List[str] = []
    for op in ops:
        if op.get("old_path"):
            paths.append(str(op["old_path"]))
        paths.append(str(op["path"]))
    return sorted(set(paths))


def _live_index_entries(repo_root: Path, paths: List[str]) -> Dict[str, Tuple[str, str]]:
    if not paths:
        return {}
    proc = subprocess.run(
        ["git", "ls-files", "-s", "-z", "--", *paths],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
    )
    if proc.returncode != 0:
        return {}
    entries: Dict[str, Tuple[str, str]] = {}
    for chunk in proc.stdout.split(b"\x00"):
        if not chunk:
            continue
        meta, _tab, path_bytes = chunk.partition(b"\t")
        parts = meta.split()
        if len(parts) >= 2:
            entries[os.fsdecode(path_bytes)] = (parts[0].decode(), parts[1].decode())
    return entries


def _tree_entries(repo_root: Path, rev: str, paths: List[str]) -> Dict[str, Tuple[str, str]]:
    if not paths:
        return {}
    proc = subprocess.run(
        ["git", "ls-tree", "-z", rev, "--", *paths],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
    )
    if proc.returncode != 0:
        return {}
    entries: Dict[str, Tuple[str, str]] = {}
    for chunk in proc.stdout.split(b"\x00"):
        if not chunk:
            continue
        meta, _tab, path_bytes = chunk.partition(b"\t")
        parts = meta.split()
        if len(parts) >= 3:
            entries[os.fsdecode(path_bytes)] = (parts[0].decode(), parts[2].decode())
    return entries


def _entry(state: Dict[str, Tuple[str, str]], path: str) -> Tuple[str, str]:
    return state.get(path) or ABSENT


def _reconcile_live_index(
    repo_root: Path,
    paths: List[str],
    pre_state: Dict[str, Tuple[str, str]],
    post_state: Dict[str, Tuple[str, str]],
    captured_index: Optional[Dict[str, Tuple[str, str]]] = None,
    conn: Any = None,
) -> None:
    live = _live_index_entries(repo_root, paths)
    safe: List[str] = []
    for path in paths:
        live_entry = live.get(path) or ABSENT
        pre_entry = _entry(pre_state, path)
        post_entry = _entry(post_state, path)
        if live_entry == post_entry:
            continue
        if captured_index is not None:
            # Tighter predicate: only reset when live still matches the index
            # snapshot captured before the publish critical section AND that
            # snapshot matched our pre-state expectation. Guards against races
            # where a concurrent writer mutated the index mid-publish.
            captured_entry = captured_index.get(path) or ABSENT
            if live_entry == captured_entry and captured_entry == pre_entry:
                safe.append(path)
        elif live_entry == pre_entry:
            safe.append(path)
    if not safe:
        return
    proc = subprocess.run(
        ["git", "reset", "-q", "--", *safe],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
        check=False,
    )
    if proc.returncode != 0 and conn is not None:
        stderr_text = proc.stderr.decode("utf-8", errors="replace").strip()
        try:
            set_daemon_meta(conn, "last_reconcile_error", stderr_text or f"git reset exited {proc.returncode}")
        except Exception:
            pass


def recover_publishing(conn, repo_root: Path, ctx: Dict[str, Any]) -> None:
    """Reconcile a crash between commit creation, update-ref, and DB settlement.

    ``publish_state`` stores the one event that was in the publish critical
    section. If the target commit is now reachable from the branch, the publish
    completed and the row can be marked ``published``. If the ref never moved
    and still equals ``source_head``, the event can safely become ``pending``
    again. Anything else is a conflict, not an opportunity to replay blindly.
    """
    row = conn.execute("SELECT * FROM publish_state WHERE id=1").fetchone()
    if row is None or row["status"] != "publishing" or row["event_seq"] is None:
        return

    event_seq = int(row["event_seq"])
    branch = str(row["branch_ref"] or "")
    target = str(row["target_commit_oid"] or "")
    source_head = str(row["source_head"] or "")
    expected_generation = int(row["branch_generation"] or 0)
    live_branch = str(ctx["branch_ref"])
    live_generation = int(ctx["branch_generation"])
    live_head = str(ctx["base_head"])

    target_reachable = False
    object_missing_exc: Optional[GitObjectMissing] = None
    reason: Optional[str] = None
    if branch != live_branch or expected_generation != live_generation:
        reason = "stale branch during publish recovery"
    elif target:
        try:
            target_reachable = _is_ancestor(repo_root, target, live_head)
        except GitObjectMissing as exc:
            # Defer the "real error" decision: if the ref never moved
            # (live_head == source_head), the target was a placeholder
            # for a commit that was never created, and the rollback path
            # below is the correct outcome. Only surface object_missing
            # as a hard failure when we cannot rollback either.
            object_missing_exc = exc
            try:
                set_daemon_meta(conn, "last_replay_object_missing", f"recover:{exc}")
            except Exception:
                pass

    if target_reachable:
        ops = [dict(op) for op in load_ops(conn, event_seq)]
        paths = _touched_paths(ops)
        _reconcile_live_index(
            repo_root,
            paths,
            _tree_entries(repo_root, source_head, paths),
            _tree_entries(repo_root, target, paths),
            conn=conn,
        )
        # Route through mark_event_published so published_ts is set
        # consistently — without it, recovered events were eligible for
        # retention pruning the moment the next sweep ran.
        mark_event_published(conn, seq=event_seq, commit_oid=target)
        update_publish_state(
            conn,
            event_seq=event_seq,
            branch_ref=live_branch,
            branch_generation=live_generation,
            source_head=source_head,
            target_commit_oid=target,
            status="published",
        )
        return

    if reason is None and live_head == source_head:
        conn.execute(
            "UPDATE capture_events SET state='pending', commit_oid=NULL, error=NULL WHERE seq=?",
            (event_seq,),
        )
        update_publish_state(
            conn,
            event_seq=None,
            branch_ref=live_branch,
            branch_generation=live_generation,
            source_head=live_head,
            target_commit_oid=None,
            status="idle",
        )
        return

    if reason is None:
        if object_missing_exc is not None:
            # The ref moved AND the recorded target cannot be resolved —
            # the queue is genuinely corrupt, not just rolled back.
            reason = f"object_missing during publish recovery: {object_missing_exc}"
        else:
            reason = "branch moved during publish recovery"

    conn.execute(
        "UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?",
        (reason, event_seq),
    )
    update_publish_state(
        conn,
        event_seq=event_seq,
        branch_ref=live_branch,
        branch_generation=live_generation,
        source_head=live_head,
        target_commit_oid=target or None,
        status="blocked_conflict",
        error=reason,
    )


def replay_pending_events(
    conn,
    repo_root: Path,
    git_dir: Path,
    *,
    lock_timeout: Optional[float] = None,
    batch_max: Optional[int] = None,
) -> int:
    """Drain pending events into commits, bounded by ``lock_timeout`` seconds.

    A blocked ``publish_lock`` is the most likely cause of the daemon's ack
    loop stalling forever, so we use a timeout by default and surface
    ``PublishLockBusy`` to the caller. The caller (the daemon main loop)
    records the error in ``daemon_meta.last_publish_error`` and acks queued
    flush rows with the failure note rather than leaving controllers hung.

    The drain is split into batches of at most ``batch_max`` events
    (``SNAPSHOTD_REPLAY_BATCH_MAX`` env var, default 200). Between
    batches we release ``publish_lock`` so sibling tools and the
    daemon's flush ackers get a turn. ``daemon_meta.last_replay_deferred``
    is updated with the still-queued count after each batch (0 when the
    lane drains).
    """
    timeout = REPLAY_PUBLISH_LOCK_TIMEOUT if lock_timeout is None else lock_timeout
    limit = batch_max if batch_max is not None else _replay_batch_max()
    if limit <= 0:
        limit = _replay_batch_max()
    total = 0
    while True:
        with publish_lock(git_dir, timeout=timeout):
            published, processed, remaining, terminated = _replay_pending_events_locked(
                conn, repo_root, git_dir, batch_limit=limit
            )
        total += published
        try:
            set_daemon_meta(conn, "last_replay_deferred", str(remaining))
        except Exception:
            pass
        # Stop when the lane drained, when the batch terminated early
        # because of a downstream-poisoning failure, or when nothing was
        # processable. Otherwise the lock has been released and the next
        # iteration re-acquires it, giving sibling tools a turn.
        if remaining == 0 or processed == 0 or terminated:
            return total


def _replay_pending_events_locked(
    conn, repo_root: Path, git_dir: Path, *, batch_limit: Optional[int] = None
) -> Tuple[int, int, int, bool]:
    """Process up to ``batch_limit`` pending events under publish_lock.

    Returns ``(published, processed, remaining, terminated)``:
      - ``published``: events that resulted in a new commit
      - ``processed``: rows touched (published + skipped/failed) — 0 means
        the caller should not loop, since nothing changed.
      - ``remaining``: pending events still queued after this batch.
      - ``terminated``: True when the batch broke early because of a
        downstream-poisoning failure (commit-tree / update-ref). The
        caller must not re-enter, since later pending events depend on
        this event's after-state and the next replay cycle has to
        rebuild the index from the live HEAD first.
    """
    ctx = repo_context(repo_root, git_dir)
    branch = ctx["branch_ref"]
    head = ctx["base_head"]
    recover_publishing(conn, repo_root, ctx)
    pending = load_pending_events(conn, branch)
    if not pending:
        return 0, 0, 0, False
    total_pending = len(pending)
    if batch_limit is not None and batch_limit > 0:
        pending = pending[:batch_limit]

    env = _clean_git_env({"GIT_INDEX_FILE": str(index_path(git_dir))})

    try:
        index_file = index_path(git_dir)
        index_file.parent.mkdir(parents=True, exist_ok=True)
        index_file.unlink(missing_ok=True)
        proc = subprocess.run(
            ["git", "read-tree", head],
            cwd=str(repo_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", errors="replace").strip())
        state = dict(snapshot_state_for_index(repo_root, env))
        parent = head
        published = 0
        processed = 0
        terminated = False

        for event in pending:
            ops = [dict(row) for row in load_ops(conn, int(event["seq"]))]
            if int(event["branch_generation"]) != int(ctx["branch_generation"]):
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="blocked_conflict",
                    error="stale branch generation",
                )
                conn.execute("UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?", ("stale branch generation", int(event["seq"])))
                processed += 1
                continue
            try:
                ancestor_ok = _is_ancestor(repo_root, str(event["base_head"]), head)
            except GitObjectMissing as exc:
                # The captured ``base_head`` cannot be resolved — typically
                # because the object store was pruned/corrupted. Surface
                # the real failure instead of papering over it as a
                # generic "stale branch ancestry" blocked_conflict.
                err_text = f"object_missing: {exc}"
                try:
                    set_daemon_meta(
                        conn,
                        "last_replay_object_missing",
                        f"seq={int(event['seq'])}: {exc}",
                    )
                except Exception:
                    pass
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="failed",
                    error=err_text,
                )
                conn.execute(
                    "UPDATE capture_events SET state='failed', error=? WHERE seq=?",
                    (err_text, int(event["seq"])),
                )
                processed += 1
                continue
            if not ancestor_ok:
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="blocked_conflict",
                    error="stale branch ancestry",
                )
                conn.execute(
                    "UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?",
                    ("stale branch ancestry", int(event["seq"])),
                )
                processed += 1
                continue
            validation_error = None
            for op in ops:
                validation_error = _validate_op(op)
                if validation_error:
                    break
            if validation_error:
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="failed",
                    error=validation_error,
                )
                conn.execute("UPDATE capture_events SET state='failed', error=? WHERE seq=?", (validation_error, int(event["seq"])))
                processed += 1
                continue

            reason = None
            for op in ops:
                reason = _verify_op(op, state)
                if reason:
                    break
            if reason:
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="blocked_conflict",
                    error=reason,
                )
                conn.execute("UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?", (reason, int(event["seq"])))
                processed += 1
                continue

            saved = dict(state)
            touched = _touched_paths(ops)
            captured_index = _live_index_entries(repo_root, touched)
            for op in ops:
                _apply_state(op, state)
            # Capture the per-event expected parent BEFORE entering the
            # publish critical section. ``recover_publishing`` will compare
            # this to the live ref tip after a crash; the previous code
            # always wrote ``head`` (the head at start-of-batch), which
            # turned every post-first-event crash into a `blocked_conflict`
            # for valid downstream events.
            event_parent = parent
            try:
                apply_ops_to_index(repo_root, env, ops)
                tree_proc = subprocess.run(
                    ["git", "write-tree"],
                    cwd=str(repo_root),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
                if tree_proc.returncode != 0:
                    raise RuntimeError(
                        tree_proc.stderr.decode("utf-8", errors="replace").strip()
                    )
                tree = tree_proc.stdout.decode("utf-8", errors="replace").strip()
                message = build_message(event, ops)
                commit_proc = subprocess.run(
                    ["git", "commit-tree", tree, "-p", event_parent],
                    cwd=str(repo_root),
                    input=message.encode("utf-8"),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
                if commit_proc.returncode != 0:
                    raise RuntimeError(
                        commit_proc.stderr.decode("utf-8", errors="replace").strip()
                    )
                commit_oid = commit_proc.stdout.decode("utf-8", errors="replace").strip()
            except Exception as exc:
                # Terminal failure (validation/commit-tree). Mark this
                # event ``failed`` and stop the batch: downstream events
                # depend on the failed event's after-state, so continuing
                # would chain `before-state mismatch` errors. The next
                # replay cycle will rebuild the index from the live HEAD
                # and re-attempt any still-pending events.
                state = saved
                _read_tree_safely(repo_root, env, event_parent, conn)
                conn.execute(
                    "UPDATE capture_events SET state='failed', error=? WHERE seq=?",
                    (str(exc), int(event["seq"])),
                )
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=event_parent,
                    target_commit_oid=None,
                    status="failed",
                    error=str(exc),
                )
                processed += 1
                terminated = True
                break

            update_publish_state(
                conn,
                event_seq=int(event["seq"]),
                branch_ref=branch,
                branch_generation=int(ctx["branch_generation"]),
                source_head=event_parent,
                target_commit_oid=commit_oid,
                status="publishing",
            )
            conn.execute("UPDATE capture_events SET state='publishing' WHERE seq=?", (int(event["seq"]),))

            try:
                proc = subprocess.run(
                    ["git", "update-ref", branch, commit_oid, event_parent],
                    cwd=str(repo_root),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
                if proc.returncode != 0:
                    raise RuntimeError(
                        proc.stderr.decode("utf-8", errors="replace").strip()
                    )
            except Exception as exc:
                # update-ref failed (typically because a concurrent push
                # moved the ref). Mark this event ``blocked_conflict`` and
                # stop the batch — the conflict has to be resolved against
                # the new branch tip before any later event can land.
                state = saved
                _read_tree_safely(repo_root, env, event_parent, conn)
                conn.execute(
                    "UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?",
                    (str(exc), int(event["seq"])),
                )
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=event_parent,
                    target_commit_oid=commit_oid,
                    status="blocked_conflict",
                    error=str(exc),
                )
                processed += 1
                terminated = True
                break

            parent = commit_oid
            published += 1
            processed += 1
            mark_event_published(conn, seq=int(event["seq"]), commit_oid=commit_oid)
            _reconcile_live_index(
                repo_root,
                touched,
                saved,
                state,
                captured_index=captured_index,
                conn=conn,
            )
            update_publish_state(
                conn,
                event_seq=int(event["seq"]),
                branch_ref=branch,
                branch_generation=int(ctx["branch_generation"]),
                source_head=event_parent,
                target_commit_oid=commit_oid,
                status="published",
            )

        # Remaining = total pending at start - rows we touched in this
        # batch. Even when ``processed < batch_size`` (an early ``break``
        # hit a fail/conflict), we still report the still-queued tail so
        # the outer loop can surface ``deferred=N`` accurately.
        remaining = max(0, total_pending - processed)
        return published, processed, remaining, terminated
    finally:
        try:
            index_path(git_dir).unlink(missing_ok=True)
        except OSError:
            pass


def _read_tree_safely(repo_root: Path, env: Dict[str, str], rev: str, conn: Any) -> None:
    """Roll the in-memory index back to ``rev``; record failures via daemon_meta."""
    proc = subprocess.run(
        ["git", "read-tree", rev],
        cwd=str(repo_root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0 and conn is not None:
        try:
            set_daemon_meta(
                conn,
                "last_replay_rollback_error",
                proc.stderr.decode("utf-8", errors="replace").strip()
                or f"git read-tree exited {proc.returncode}",
            )
        except Exception:
            pass


def cmd_status(repo_root: Path, git_dir: Path) -> int:
    conn = ensure_state(git_dir)
    try:
        payload = status_snapshot(conn, git_dir)
        payload["repo_root"] = str(repo_root)
        payload["git_dir"] = str(git_dir)
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    finally:
        conn.close()


def cmd_flush(repo_root: Path, git_dir: Path) -> int:
    conn = ensure_state(git_dir)
    try:
        published = replay_pending_events(conn, repo_root, git_dir)
        print(f"published={published}")
        return 0
    finally:
        conn.close()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Replay daemon snapshot events")
    parser.add_argument("--repo", default=os.getcwd(), help="repo working directory")
    parser.add_argument("--git-dir", help="explicit git dir override")
    parser.add_argument("--status", action="store_true", help="print queue status")
    parser.add_argument("--flush", action="store_true", help="drain pending events")
    args = parser.parse_args(argv)

    repo_input = Path(args.repo).expanduser()
    try:
        repo_root, git_dir, _common = resolve_repo_paths(repo_input)
        if args.git_dir:
            git_dir = Path(args.git_dir).expanduser().resolve()
    except Exception as exc:
        print(f"not a git repository: {exc}", file=sys.stderr)
        return 1

    if args.status:
        return cmd_status(repo_root, git_dir)
    if args.flush:
        return cmd_flush(repo_root, git_dir)
    return cmd_status(repo_root, git_dir)


if __name__ == "__main__":
    sys.exit(main())

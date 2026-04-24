#!/usr/bin/env python3
"""Replay captured snapshot events into real git commits.

The replay path is deliberately conservative: it loads a worktree-local SQLite
queue, validates branch ownership through the shared registry helper, creates
one commit per captured event by default, and publishes the result with a
compare-and-swap ``git update-ref``.
"""

from __future__ import annotations

import argparse
import os
import sys
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
WORKER_DIR = HERE.parent / "atomic-commit-snapshot-worker"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from snapshot_state import (
    apply_ops_to_index,
    build_message,
    ensure_state,
    index_path,
    load_ops,
    load_pending_events,
    repo_context,
    resolve_repo_paths,
    snapshot_state_for_index,
    status_snapshot,
    update_publish_state,
)


def _is_ancestor(repo_root: Path, ancestor: str, descendant: str) -> bool:
    proc = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc.returncode == 0


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
        state[path] = (op.get("after_mode") or "100644", op.get("after_oid") or "0" * 40)
    elif kind == "delete":
        state.pop(path, None)
    elif kind == "rename":
        old_path = op.get("old_path") or ""
        if old_path:
            state.pop(old_path, None)
        state[path] = (op.get("after_mode") or "100644", op.get("after_oid") or "0" * 40)


def replay_pending_events(conn, repo_root: Path, git_dir: Path) -> int:
    ctx = repo_context(repo_root, git_dir)
    branch = ctx["branch_ref"]
    head = ctx["base_head"]
    pending = load_pending_events(conn, branch)
    if not pending:
        return 0

    env = os.environ.copy()
    env["GIT_INDEX_FILE"] = str(index_path(git_dir))

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
                continue
            if not _is_ancestor(repo_root, str(event["base_head"]), head):
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
                continue

            saved = dict(state)
            for op in ops:
                _apply_state(op, state)
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
                    ["git", "commit-tree", tree, "-p", parent],
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
                state = saved
                conn.execute("UPDATE capture_events SET state='failed', error=? WHERE seq=?", (str(exc), int(event["seq"])))
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="failed",
                    error=str(exc),
                )
                continue

            update_publish_state(
                conn,
                event_seq=int(event["seq"]),
                branch_ref=branch,
                branch_generation=int(ctx["branch_generation"]),
                source_head=head,
                target_commit_oid=commit_oid,
                status="publishing",
            )
            conn.execute("UPDATE capture_events SET state='publishing' WHERE seq=?", (int(event["seq"]),))

            try:
                proc = subprocess.run(
                    ["git", "update-ref", branch, commit_oid, parent],
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
                conn.execute("UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?", (str(exc), int(event["seq"])))
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=commit_oid,
                    status="blocked_conflict",
                    error=str(exc),
                )
                continue

            parent = commit_oid
            published += 1
            conn.execute("UPDATE capture_events SET state='published', commit_oid=?, error=NULL WHERE seq=?", (commit_oid, int(event["seq"])))
            update_publish_state(
                conn,
                event_seq=int(event["seq"]),
                branch_ref=branch,
                branch_generation=int(ctx["branch_generation"]),
                source_head=head,
                target_commit_oid=commit_oid,
                status="published",
            )

        return published
    finally:
        try:
            index_path(git_dir).unlink(missing_ok=True)
        except OSError:
            pass


def cmd_status(repo_root: Path, git_dir: Path) -> int:
    conn = ensure_state(git_dir)
    try:
        payload = status_snapshot(conn, git_dir)
        payload["repo_root"] = str(repo_root)
        payload["git_dir"] = str(git_dir)
        print(__import__("json").dumps(payload, indent=2, sort_keys=True))
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

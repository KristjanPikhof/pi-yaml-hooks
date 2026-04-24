#!/usr/bin/env python3
"""Worktree-local daemon for polling capture and replay control.

This example keeps one daemon per worktree git dir, maintains a heartbeat in
SQLite, processes controller request rows, and uses the portable rescan backend
from ``snapshot-capture.py``.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import snapshot_state  # noqa: E402


POLL_INTERVAL = float(os.environ.get("SNAPSHOTD_POLL_INTERVAL", "0.75"))
SLEEP_INTERVAL = float(os.environ.get("SNAPSHOTD_SLEEP_INTERVAL", "2.0"))


def _load_path_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, str(HERE / filename))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capture = _load_path_module("snapshot_capture", "snapshot-capture.py")


def _load_replay_module():
    return _load_path_module("snapshot_replay", "snapshot-replay.py")


def _request_rows(conn):
    return conn.execute(
        "SELECT id, command, non_blocking FROM flush_requests WHERE acknowledged_ts IS NULL ORDER BY id"
    ).fetchall()


def _ack(conn, request_id: int, note: str = "") -> None:
    snapshot_state.acknowledge_flush(conn, request_id, note)


def _replay_pending(conn, repo_root: Path, git_dir: Path) -> int:
    module = _load_replay_module()
    return int(module.replay_pending_events(conn, repo_root, git_dir))


def _pending_event_count(conn) -> int:
    row = conn.execute("SELECT COUNT(*) FROM capture_events WHERE state='pending'").fetchone()
    return int(row[0] if row else 0)


def _capture_then_replay(conn, repo_root: Path, git_dir: Path) -> int:
    """Capture the current stable polling snapshot before draining commits."""
    capture.poll_once(conn, repo_root, git_dir)
    return _replay_pending(conn, repo_root, git_dir) if _pending_event_count(conn) else 0


def process_requests(
    conn,
    repo_root: Path,
    git_dir: Path,
    *,
    sleeping: bool,
    stop_event: threading.Event,
) -> bool:
    """Process queued wake/flush/sleep/stop rows.

    Returns the updated sleep state.
    """

    for row in _request_rows(conn):
        command = str(row["command"])
        request_id = int(row["id"])
        note = command
        if command == "wake":
            sleeping = False
            note = "wake acknowledged"
        elif command == "flush":
            published = _capture_then_replay(conn, repo_root, git_dir)
            note = f"flush acknowledged; published={published}"
        elif command == "sleep":
            sleeping = True
            note = "sleep acknowledged"
        elif command == "stop":
            published = _capture_then_replay(conn, repo_root, git_dir)
            note = f"stop acknowledged; published={published}"
            sleeping = True
            stop_event.set()
        else:
            note = f"ignored command={command}"
        _ack(conn, request_id, note)
    return sleeping


def _heartbeat(conn, pid: int, mode: str, ctx: Dict[str, Any], note: str = "") -> None:
    snapshot_state.set_daemon_state(
        conn,
        pid=pid,
        mode=mode,
        branch_ref=ctx["branch_ref"],
        branch_generation=ctx["branch_generation"],
        note=note,
    )


def run_daemon(repo_root: Path, git_dir: Path) -> int:
    conn = snapshot_state.ensure_state(git_dir)
    lock_path = snapshot_state.lock_path(git_dir)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_fh = lock_path.open("a+")
    try:
        import fcntl

        try:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return 0

        ctx = snapshot_state.repo_context(repo_root, git_dir)
        capture.bootstrap_shadow(
            conn,
            repo_root,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            base_head=ctx["base_head"],
        )

        stop_event = threading.Event()
        wake_event = threading.Event()

        def _stop(*_args: Any) -> None:
            stop_event.set()

        def _wake(*_args: Any) -> None:
            wake_event.set()

        signal.signal(signal.SIGTERM, _stop)
        signal.signal(signal.SIGINT, _stop)
        signal.signal(signal.SIGUSR1, _wake)

        sleeping = False
        _heartbeat(conn, os.getpid(), "running", ctx, note="daemon started")
        conn.commit()

        while not stop_event.is_set():
            if wake_event.is_set():
                sleeping = False
                wake_event.clear()

            sleeping = process_requests(
                conn,
                repo_root,
                git_dir,
                sleeping=sleeping,
                stop_event=stop_event,
            )
            if stop_event.is_set():
                break

            mode = "sleeping" if sleeping else "running"
            _heartbeat(conn, os.getpid(), mode, ctx)
            conn.commit()

            if not sleeping:
                try:
                    capture.poll_once(conn, repo_root, git_dir)
                except Exception as exc:
                    _heartbeat(conn, os.getpid(), "running", ctx, note=f"capture error: {exc}")
                conn.commit()

            interval = SLEEP_INTERVAL if sleeping else POLL_INTERVAL
            deadline = time.time() + interval
            while time.time() < deadline and not stop_event.is_set() and not wake_event.is_set():
                time.sleep(0.1)

        _heartbeat(conn, os.getpid(), "stopped", ctx, note="daemon stopping")
        conn.commit()
        return 0
    finally:
        conn.close()
        try:
            lock_fh.close()
        except OSError:
            pass


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run the worktree snapshot daemon")
    parser.add_argument("--repo", default=os.getcwd(), help="repo working directory")
    parser.add_argument("--git-dir", help="explicit git dir override")
    args = parser.parse_args(argv)

    repo_input = Path(args.repo).expanduser()
    try:
        repo_root, git_dir, _common = snapshot_state.resolve_repo_paths(repo_input)
        if args.git_dir:
            git_dir = Path(args.git_dir).expanduser().resolve()
    except Exception as exc:
        print(f"not a git repository: {exc}", file=sys.stderr)
        return 1

    return run_daemon(repo_root, git_dir)


if __name__ == "__main__":
    sys.exit(main())

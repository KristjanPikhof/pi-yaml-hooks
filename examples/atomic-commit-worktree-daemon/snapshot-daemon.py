#!/usr/bin/env python3
"""Worktree-local daemon for polling capture and replay control.

This example keeps one daemon per worktree git dir, maintains a heartbeat in
SQLite, processes controller request rows, and uses the portable rescan backend
from ``snapshot-capture.py``.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
import signal
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

EX_TEMPFAIL = 75

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
    try:
        capture.poll_once(conn, repo_root, git_dir)
        snapshot_state.set_daemon_meta(conn, "last_capture_error", "")
    except Exception as exc:
        snapshot_state.set_daemon_meta(conn, "last_capture_error", str(exc))
        raise
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

    Flush rows for the same tick share one capture+replay cycle and a common
    ack note so N queued flushes cost O(1) work instead of N.

    Returns the updated sleep state.
    """

    rows = _request_rows(conn)
    if not rows:
        return sleeping

    # Snapshot requests per command so we can coalesce within this tick.
    flush_ids: list[int] = []
    stop_ids: list[int] = []
    other: list[tuple[int, str]] = []
    for row in rows:
        command = str(row["command"])
        request_id = int(row["id"])
        if command == "flush":
            flush_ids.append(request_id)
        elif command == "stop":
            stop_ids.append(request_id)
        else:
            other.append((request_id, command))

    flush_note: Optional[str] = None
    if flush_ids:
        published = _capture_then_replay(conn, repo_root, git_dir)
        flush_note = (
            f"flush acknowledged; published={published}; coalesced={len(flush_ids)}"
        )
        for rid in flush_ids:
            _ack(conn, rid, flush_note)

    stop_note: Optional[str] = None
    if stop_ids:
        # Stops always perform their own capture+replay; if we already ran one
        # for flushes this tick, reuse the published count for clarity.
        if flush_note is None:
            published = _capture_then_replay(conn, repo_root, git_dir)
        else:
            published = 0
        stop_note = (
            f"stop acknowledged; published={published}; coalesced={len(stop_ids)}"
        )
        for rid in stop_ids:
            _ack(conn, rid, stop_note)
        sleeping = True
        stop_event.set()

    for request_id, command in other:
        if command == "wake":
            sleeping = False
            note = "wake acknowledged"
        elif command == "sleep":
            sleeping = True
            note = "sleep acknowledged"
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


def _new_daemon_token() -> str:
    return hashlib.sha256(
        f"{uuid.uuid4()}|{os.getpid()}|{time.time_ns()}".encode("utf-8")
    ).hexdigest()


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
            # Another daemon holds the flock. Don't clobber its state row if
            # it still has a fresh heartbeat — just record a short note on the
            # existing row and exit with EX_TEMPFAIL so the caller can tell
            # "peer running" from "started cleanly".
            row = conn.execute(
                "SELECT pid, mode, heartbeat_ts FROM daemon_state WHERE id=1"
            ).fetchone()
            peer_pid = int(row["pid"]) if row and row["pid"] is not None else 0
            peer_fresh = (
                row is not None
                and peer_pid > 0
                and snapshot_state.heartbeat_alive(peer_pid)
                and (time.time() - float(row["heartbeat_ts"] or 0)) < 15.0
            )
            if not peer_fresh:
                snapshot_state.set_daemon_state(
                    conn,
                    pid=os.getpid(),
                    mode="lock-contended",
                    note="peer daemon holds flock",
                    daemon_token=_new_daemon_token(),
                )
                conn.commit()
            return EX_TEMPFAIL

        daemon_token = _new_daemon_token()

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
        snapshot_state.set_daemon_state(
            conn,
            pid=os.getpid(),
            mode="running",
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            note="daemon started",
            daemon_token=daemon_token,
        )
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
                    snapshot_state.set_daemon_meta(conn, "last_capture_error", "")
                except Exception as exc:
                    snapshot_state.set_daemon_meta(conn, "last_capture_error", str(exc))
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

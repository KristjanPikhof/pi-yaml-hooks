#!/usr/bin/env python3
"""Hook-safe controller for the worktree daemon example.

The controller stays cheap: it records request rows in the worktree-local DB,
uses short locks, and only launches ``snapshot-daemon.py`` when that script is
actually present. If the daemon script is missing, the CLI degrades clearly
instead of pretending to manage a background watcher.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

import snapshot_state

from snapshot_state import (
    control_lock,
    ensure_state,
    heartbeat_alive,
    current_branch,
    request_flush,
    resolve_repo_paths,
    set_daemon_state,
    status_snapshot,
)


ACK_TIMEOUT = float(os.environ.get("SNAPSHOTD_ACK_TIMEOUT", "30.0"))
FRESH_HEARTBEAT_SECONDS = float(os.environ.get("SNAPSHOTD_HEARTBEAT_FRESH_SECONDS", "15.0"))
START_READY_TIMEOUT = float(os.environ.get("SNAPSHOTD_START_READY_TIMEOUT", "1.0"))


def daemon_script_path() -> Path:
    return Path(__file__).resolve().with_name("snapshot-daemon.py")


def _daemon_row(conn) -> Dict[str, Any]:
    row = conn.execute("SELECT * FROM daemon_state WHERE id=1").fetchone()
    return dict(row) if row else {}


def _refresh_mode(conn, mode: str, note: str = "") -> None:
    row = _daemon_row(conn)
    set_daemon_state(
        conn,
        pid=int(row.get("pid") or 0),
        mode=mode,
        branch_ref=row.get("branch_ref"),
        branch_generation=row.get("branch_generation"),
        note=note,
    )


def _light_context(repo_root: Path) -> Dict[str, Any]:
    branch = current_branch(repo_root)
    head = snapshot_state.current_head(repo_root)
    if branch is None:
        raise RuntimeError("detached or unborn HEAD is not replay-safe")
    if head is None:
        raise RuntimeError("unable to resolve HEAD")
    return {"branch_ref": branch, "base_head": head}


def _spawn_daemon(repo_root: Path, git_dir: Path) -> Optional[subprocess.Popen[str]]:
    script = daemon_script_path()
    if not script.exists():
        return None
    return subprocess.Popen(
        [sys.executable, str(script), "--repo", str(repo_root), "--git-dir", str(git_dir)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _fresh_heartbeat(row: Dict[str, Any]) -> bool:
    heartbeat_ts = float(row.get("heartbeat_ts") or 0)
    pid = int(row.get("pid") or 0)
    if row.get("mode") == "degraded-no-daemon" and (time.time() - heartbeat_ts) < FRESH_HEARTBEAT_SECONDS:
        return True
    if not heartbeat_alive(pid):
        return False
    return (time.time() - heartbeat_ts) < FRESH_HEARTBEAT_SECONDS


def _maybe_start(repo_root: Path, git_dir: Path, conn, note: str = "") -> Dict[str, Any]:
    row = _daemon_row(conn)
    if row and _fresh_heartbeat(row):
        return {"started": False, "reason": "fresh heartbeat already present", "daemon": row}
    proc = _spawn_daemon(repo_root, git_dir)
    if proc is None:
        set_daemon_state(conn, pid=0, mode="degraded-no-daemon", note="snapshot-daemon.py missing")
        return {"started": False, "reason": "snapshot-daemon.py missing", "daemon": _daemon_row(conn)}
    # Don't clobber yet — the child will write its own row once it's running.
    deadline = time.time() + START_READY_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            # Child exited quickly. That may mean it lost a flock race with an
            # existing peer (which stamped itself into daemon_state already),
            # or it genuinely crashed. Re-read before assuming the worst.
            current = _daemon_row(conn)
            current_pid = int(current.get("pid") or 0)
            if (
                current_pid
                and current_pid != proc.pid
                and _fresh_heartbeat(current)
            ):
                return {
                    "started": False,
                    "reason": "peer daemon already running",
                    "daemon": current,
                }
            set_daemon_state(conn, pid=0, mode="stopped", note="daemon exited during startup")
            return {"started": False, "reason": "daemon exited during startup", "daemon": _daemon_row(conn)}
        current = _daemon_row(conn)
        current_pid = int(current.get("pid") or 0)
        if current_pid == proc.pid and current.get("mode") in {"bootstrapping", "running"}:
            return {"started": True, "pid": proc.pid, "daemon": current}
        time.sleep(0.05)
    return {"started": True, "pid": proc.pid, "ready": False, "reason": "daemon readiness timeout", "daemon": _daemon_row(conn)}


def cmd_start(repo_root: Path, git_dir: Path) -> int:
    conn = ensure_state(git_dir)
    try:
        with control_lock(git_dir):
            row = _daemon_row(conn)
            if row and _fresh_heartbeat(row):
                print(json.dumps({"ok": True, "action": "start", "duplicate": True, "daemon": row}, indent=2))
                return 0
            ctx = _light_context(repo_root)
            if row.get("pid") and not heartbeat_alive(int(row.get("pid") or 0)):
                set_daemon_state(conn, pid=0, mode="stale-heartbeat", note="replaced stale daemon")
            result = _maybe_start(repo_root, git_dir, conn, note="start request")
            result["action"] = "start"
            result["branch"] = ctx["branch_ref"]
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
    finally:
        conn.close()


def _signal_daemon(conn, sig: signal.Signals, expected_token: Optional[str] = None) -> bool:
    """Send ``sig`` to the recorded daemon pid, guarding against PID reuse.

    The daemon writes a random ``daemon_token`` into daemon_state on startup.
    If ``expected_token`` is passed, the row must still advertise that token
    before we signal — otherwise a recycled PID belonging to an unrelated
    process could receive our signal. When no expected token is supplied we
    fall back to the current row's token (caller-less flows like SIGUSR1
    wake-ups that just re-read state).
    """
    row = _daemon_row(conn)
    pid = int(row.get("pid") or 0)
    if pid <= 0 or not heartbeat_alive(pid):
        return False
    row_token = row.get("daemon_token")
    if expected_token is not None and row_token != expected_token:
        return False
    if row_token is None:
        # No identity on record — refuse rather than risk signaling an
        # unrelated process that happens to share the pid.
        return False
    try:
        os.kill(pid, sig)
        return True
    except OSError:
        return False


def _wait_for_ack(conn, request_id: int, timeout: float = ACK_TIMEOUT) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        row = conn.execute(
            "SELECT acknowledged_ts FROM flush_requests WHERE id=?",
            (request_id,),
        ).fetchone()
        if row and row[0]:
            return True
        time.sleep(0.05)
    return False


def _settle_pending_requests(conn, note: str, request_id: Optional[int] = None) -> None:
    """Settle one request row (or all pending if no id given).

    ``request_id`` is the row created by the current controller command.
    Scoping by id avoids falsely acking concurrent flushes from other
    controllers when we only intended to close our own stop request.
    """
    now = time.time()
    if request_id is None:
        conn.execute(
            """UPDATE flush_requests
               SET acknowledged_ts=?, completed_ts=?, status='acknowledged',
                   note=COALESCE(note, '') || ?
               WHERE acknowledged_ts IS NULL""",
            (now, now, f"; {note}"),
        )
    else:
        conn.execute(
            """UPDATE flush_requests
               SET acknowledged_ts=?, completed_ts=?, status='acknowledged',
                   note=COALESCE(note, '') || ?
               WHERE id=? AND acknowledged_ts IS NULL""",
            (now, now, f"; {note}", request_id),
        )


def _flush_locked(repo_root: Path, git_dir: Path, conn, non_blocking: bool) -> tuple[int, bool, str]:
    ctx = _light_context(repo_root)
    request_id = request_flush(conn, "flush", non_blocking, note="flush requested")
    signaled = _signal_daemon(conn, signal.SIGUSR1)
    if non_blocking:
        return request_id, signaled, ctx["branch_ref"]
    if not signaled and not daemon_script_path().exists():
        if not _wait_for_ack(conn, request_id, timeout=0.1):
            raise TimeoutError("daemon is absent; flush recorded but not acknowledged")
    if not _wait_for_ack(conn, request_id):
        raise TimeoutError("flush timed out waiting for daemon ack")
    return request_id, signaled, ctx["branch_ref"]


def cmd_wake(repo_root: Path, git_dir: Path) -> int:
    conn = ensure_state(git_dir)
    try:
        with control_lock(git_dir):
            ctx = _light_context(repo_root)
            request_id = request_flush(conn, "wake", True, note="wake requested")
            if not _signal_daemon(conn, signal.SIGUSR1):
                _maybe_start(repo_root, git_dir, conn, note="wake-start fallback")
            print(json.dumps({"ok": True, "action": "wake", "request_id": request_id, "branch": ctx["branch_ref"]}, indent=2))
            return 0
    finally:
        conn.close()


def cmd_flush(repo_root: Path, git_dir: Path, non_blocking: bool) -> int:
    conn = ensure_state(git_dir)
    try:
        with control_lock(git_dir):
            request_id, signaled, branch = _flush_locked(repo_root, git_dir, conn, non_blocking)
            if non_blocking:
                print(json.dumps({"ok": True, "action": "flush", "non_blocking": True, "request_id": request_id, "signaled": signaled, "branch": branch}, indent=2))
                return 0
            print(json.dumps({"ok": True, "action": "flush", "request_id": request_id, "branch": branch}, indent=2))
            return 0
    except TimeoutError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    finally:
        conn.close()


def cmd_sleep(repo_root: Path, git_dir: Path) -> int:
    conn = ensure_state(git_dir)
    try:
        with control_lock(git_dir):
            ctx = _light_context(repo_root)
            request_id = request_flush(conn, "sleep", True, note="sleep requested")
            _signal_daemon(conn, signal.SIGUSR1)
            _refresh_mode(conn, "sleeping", note="sleep requested")
            print(json.dumps({"ok": True, "action": "sleep", "request_id": request_id, "branch": ctx["branch_ref"]}, indent=2))
            return 0
    finally:
        conn.close()


def _wait_for_exit(pid: int, lock_path: Path, timeout: float) -> bool:
    """Poll until the daemon pid is gone AND its flock is released."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not heartbeat_alive(pid) and not _lock_is_held(lock_path):
            return True
        time.sleep(0.05)
    return not heartbeat_alive(pid) and not _lock_is_held(lock_path)


def _lock_is_held(lock_path: Path) -> bool:
    if not lock_path.exists():
        return False
    import fcntl as _fcntl
    try:
        with lock_path.open("a+") as fh:
            try:
                _fcntl.flock(fh.fileno(), _fcntl.LOCK_EX | _fcntl.LOCK_NB)
            except OSError:
                return True
            _fcntl.flock(fh.fileno(), _fcntl.LOCK_UN)
        return False
    except OSError:
        return False


def cmd_stop(repo_root: Path, git_dir: Path, flush_first: bool) -> int:
    conn = ensure_state(git_dir)
    try:
        with control_lock(git_dir):
            ctx = _light_context(repo_root)
            if flush_first:
                try:
                    _flush_locked(repo_root, git_dir, conn, non_blocking=False)
                except TimeoutError as exc:
                    print(str(exc), file=sys.stderr)
            request_id = request_flush(conn, "stop", False, note="stop requested")
            row = _daemon_row(conn)
            pid = int(row.get("pid") or 0)
            cached_token = row.get("daemon_token")
            lock_fp = snapshot_state.lock_path(git_dir)

            if pid > 0 and heartbeat_alive(pid):
                _signal_daemon(conn, signal.SIGUSR1, expected_token=cached_token)
                if not _wait_for_ack(conn, request_id):
                    # Daemon did not consume the stop row in time; fall through
                    # to SIGTERM then (if necessary) SIGKILL.
                    pass

                # Ask politely, then verify exit.
                try:
                    if heartbeat_alive(pid):
                        os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
                if not _wait_for_exit(pid, lock_fp, ACK_TIMEOUT):
                    # Escalate to SIGKILL with a bounded grace window.
                    try:
                        if heartbeat_alive(pid):
                            os.kill(pid, signal.SIGKILL)
                    except OSError:
                        pass
                    if not _wait_for_exit(pid, lock_fp, 1.0):
                        _settle_pending_requests(conn, "stop requested; escalation failed", request_id=request_id)
                        print(
                            json.dumps(
                                {
                                    "ok": False,
                                    "action": "stop",
                                    "request_id": request_id,
                                    "branch": ctx["branch_ref"],
                                    "error": "daemon refused to stop",
                                    "pid": pid,
                                },
                                indent=2,
                            ),
                            file=sys.stderr,
                        )
                        return 1
                _settle_pending_requests(conn, "daemon stopped", request_id=request_id)
            else:
                _settle_pending_requests(conn, "stop acknowledged; daemon absent", request_id=request_id)
            _refresh_mode(conn, "stopped", note="stop requested")
            print(json.dumps({"ok": True, "action": "stop", "request_id": request_id, "branch": ctx["branch_ref"], "flushed": flush_first}, indent=2))
            return 0
    finally:
        conn.close()


def cmd_status(repo_root: Path, git_dir: Path) -> int:
    conn = ensure_state(git_dir)
    try:
        payload = status_snapshot(conn, git_dir)
        payload["repo_root"] = str(repo_root)
        payload["git_dir"] = str(git_dir)
        payload["daemon_script"] = str(daemon_script_path())
        payload["daemon_script_present"] = daemon_script_path().exists()
        # Read-only stale-heartbeat overlay: don't mutate the row, but if it
        # claims to be alive while the heartbeat has gone cold, surface that
        # so operators see the truth without manual log digging.
        active_modes = {"running", "sleeping", "starting", "bootstrapping"}
        daemon_row = payload.get("daemon") or {}
        if daemon_row.get("mode") in active_modes and not _fresh_heartbeat(daemon_row):
            heartbeat_ts = float(daemon_row.get("heartbeat_ts") or 0)
            payload["daemon"] = {
                **daemon_row,
                "mode": "stale-heartbeat",
                "reported_mode": daemon_row.get("mode"),
                "heartbeat_age_seconds": round(time.time() - heartbeat_ts, 3),
            }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    finally:
        conn.close()


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Control the worktree daemon example")
    parser.add_argument("command", choices=["start", "wake", "flush", "sleep", "stop", "status"])
    parser.add_argument("--repo", default=os.getcwd(), help="repo working directory")
    parser.add_argument("--git-dir", help="explicit git dir override")
    parser.add_argument("--non-blocking", action="store_true", help="return immediately after flush request")
    parser.add_argument("--flush", action="store_true", help="drain before stopping")
    args = parser.parse_args(argv)

    repo_input = Path(args.repo).expanduser()
    try:
        repo_root, git_dir, _common = resolve_repo_paths(repo_input)
        if args.git_dir:
            git_dir = Path(args.git_dir).expanduser().resolve()
    except Exception as exc:
        print(f"not a git repository: {exc}", file=sys.stderr)
        return 1

    if args.command == "start":
        return cmd_start(repo_root, git_dir)
    if args.command == "wake":
        return cmd_wake(repo_root, git_dir)
    if args.command == "flush":
        return cmd_flush(repo_root, git_dir, non_blocking=args.non_blocking)
    if args.command == "sleep":
        return cmd_sleep(repo_root, git_dir)
    if args.command == "stop":
        return cmd_stop(repo_root, git_dir, flush_first=args.flush)
    return cmd_status(repo_root, git_dir)


if __name__ == "__main__":
    sys.exit(main())

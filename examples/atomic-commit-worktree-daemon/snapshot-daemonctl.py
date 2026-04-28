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
from typing import Any, Dict, Optional, Tuple

import snapshot_state

from snapshot_state import (
    DetachedHeadError,
    client_count,
    control_lock,
    deregister_client,
    ensure_state,
    heartbeat_alive,
    current_branch,
    gc_dead_clients,
    process_fingerprint,
    register_client,
    request_flush,
    resolve_repo_paths,
    set_daemon_state,
    status_snapshot,
    touch_client,
    verify_process_identity,
)


ACK_TIMEOUT = float(os.environ.get("SNAPSHOTD_ACK_TIMEOUT", "30.0"))
FRESH_HEARTBEAT_SECONDS = float(os.environ.get("SNAPSHOTD_HEARTBEAT_FRESH_SECONDS", "15.0"))
START_READY_TIMEOUT = float(os.environ.get("SNAPSHOTD_START_READY_TIMEOUT", "1.0"))


def _resolve_session_pid(explicit: Optional[int]) -> Optional[int]:
    """Pick the pi-harness pid to record as the daemon-keepalive client.

    Priority:
      1. Explicit ``--session-pid`` arg from the hook bash action.
      2. ``$PI_SESSION_PID`` env var if pi-hooks ever exposes it.
      3. Walk parents of this controller process until we find a likely pi
         entry. The walk is best-effort: a missed walk just means this
         particular session won't refcount and the daemon may exit earlier
         than ideal — never worse than the current behaviour.

    Returns ``None`` when no plausible pid is found, and callers fall back to
    the legacy unconditional-stop semantics.
    """
    if explicit is not None and explicit > 0:
        return explicit
    raw = os.environ.get("PI_SESSION_PID")
    if raw:
        try:
            value = int(raw)
            if value > 0:
                return value
        except ValueError:
            pass
    return _walk_parents_for_pi(os.getppid())


def _walk_parents_for_pi(start_pid: int, max_steps: int = 8) -> Optional[int]:
    """Walk up the process tree looking for a pi-harness ancestor.

    Stops at pid 1 (launchd / init) or after ``max_steps`` hops. Uses ``ps``
    so we don't depend on /proc, which macOS lacks.
    """
    pid = int(start_pid)
    for _ in range(max_steps):
        if pid <= 1:
            return None
        try:
            proc = subprocess.run(
                ["ps", "-o", "ppid=,command=", "-p", str(pid)],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            return None
        line = proc.stdout.strip()
        if not line:
            return None
        ppid_str, _space, command = line.partition(" ")
        try:
            ppid = int(ppid_str.strip())
        except ValueError:
            return None
        cmd_lower = command.strip().lower()
        # Match common pi launchers: ``pi``, ``pi-harness``, ``pi.app/``,
        # ``node …/pi/cli``. Substring + boundary checks keep false positives
        # low without requiring a hard list of binary names.
        if any(
            marker in cmd_lower
            for marker in ("/pi ", "/pi\t", "pi-harness", "/pi-cli", "pi.app/")
        ) or cmd_lower.endswith("/pi") or cmd_lower == "pi":
            return pid
        pid = ppid
    return None


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
        raise DetachedHeadError("detached or unborn HEAD is not replay-safe")
    if not branch.startswith("refs/heads/"):
        raise DetachedHeadError(
            f"HEAD points at {branch}, not a refs/heads/ branch — refusing to operate"
        )
    if head is None:
        raise RuntimeError("unable to resolve HEAD")
    return {"branch_ref": branch, "base_head": head}


def _spawn_daemon(repo_root: Path, git_dir: Path) -> Optional[subprocess.Popen[bytes]]:
    script = daemon_script_path()
    if not script.exists():
        return None
    return subprocess.Popen(
        [sys.executable, str(script), "--repo", str(repo_root), "--git-dir", str(git_dir)],
        stdin=subprocess.DEVNULL,
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
            # or it genuinely crashed. The peer's heartbeat write may not yet
            # be visible — give it a brief, bounded settle window before
            # declaring the daemon dead, so a normal peer-handoff doesn't get
            # mis-reported as a startup crash.
            peer_row: Dict[str, Any] = {}
            for _attempt in range(3):
                current = _daemon_row(conn)
                current_pid = int(current.get("pid") or 0)
                if (
                    current_pid
                    and current_pid != proc.pid
                    and _fresh_heartbeat(current)
                ):
                    peer_row = current
                    break
                time.sleep(0.05)
            if peer_row:
                return {
                    "started": False,
                    "reason": "peer daemon already running",
                    "daemon": peer_row,
                }
            set_daemon_state(conn, pid=0, mode="stopped", note="daemon exited during startup")
            return {"started": False, "reason": "daemon exited during startup", "daemon": _daemon_row(conn)}
        current = _daemon_row(conn)
        current_pid = int(current.get("pid") or 0)
        if current_pid == proc.pid and current.get("mode") in {"bootstrapping", "running"}:
            return {"started": True, "pid": proc.pid, "daemon": current}
        time.sleep(0.05)
    return {"started": True, "pid": proc.pid, "ready": False, "reason": "daemon readiness timeout", "daemon": _daemon_row(conn)}


def _register_session_client(conn, session_pid: Optional[int]) -> Optional[int]:
    """Register one pi session as a daemon client; return the recorded pid.

    No-op when ``session_pid`` is None or when we cannot fingerprint the
    process (already exited, permission denied). The daemon's GC sweep is
    the source of truth for liveness, so a missing fingerprint is safer to
    skip than to record under a placeholder that would never expire.
    """
    if session_pid is None or session_pid <= 0:
        return None
    fp = process_fingerprint(session_pid)
    if not fp:
        return None
    register_client(conn, session_pid, fp)
    return session_pid


def cmd_start(
    repo_root: Path, git_dir: Path, session_pid: Optional[int] = None
) -> int:
    conn = ensure_state(git_dir)
    try:
        with control_lock(git_dir):
            registered_pid = _register_session_client(conn, session_pid)
            row = _daemon_row(conn)
            if row and _fresh_heartbeat(row):
                payload = {
                    "ok": True,
                    "action": "start",
                    "duplicate": True,
                    "daemon": row,
                    "session_pid": registered_pid,
                    "client_count": client_count(conn),
                }
                print(json.dumps(payload, indent=2, sort_keys=True, default=str))
                return 0
            ctx = _light_context(repo_root)
            if row.get("pid") and not heartbeat_alive(int(row.get("pid") or 0)):
                set_daemon_state(conn, pid=0, mode="stale-heartbeat", note="replaced stale daemon")
            result = _maybe_start(repo_root, git_dir, conn, note="start request")
            result["action"] = "start"
            result["branch"] = ctx["branch_ref"]
            result["session_pid"] = registered_pid
            result["client_count"] = client_count(conn)
            print(json.dumps(result, indent=2, sort_keys=True, default=str))
            return 0
    except DetachedHeadError as exc:
        print(f"refusing to start daemon: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def _verified_target(
    conn, *, expected_token: Optional[str] = None
) -> Optional[Tuple[int, str, str]]:
    """Return (pid, token, fingerprint) for the daemon iff its identity verifies.

    Verification has two layers:

    1. The DB row's ``daemon_token`` must match ``expected_token`` (if
       supplied) — protects against a daemon restart we didn't initiate.
    2. The pid's *current* OS-level fingerprint (process start time + argv)
       must match the fingerprint recorded by the daemon at bootstrap. This
       closes the PID-reuse window that token-equals-token alone left open:
       a recycled pid owned by an unrelated user-process has a different
       start time and so cannot pass this check.

    Returns ``None`` when no daemon is running or identity cannot be
    confirmed — callers must refuse to signal in that case.
    """
    row = _daemon_row(conn)
    pid = int(row.get("pid") or 0)
    if pid <= 0:
        return None
    if not heartbeat_alive(pid):
        return None
    row_token = row.get("daemon_token")
    if not row_token:
        return None
    if expected_token is not None and row_token != expected_token:
        return None
    fingerprint = row.get("daemon_fingerprint")
    if not fingerprint or not verify_process_identity(pid, fingerprint):
        return None
    return pid, str(row_token), str(fingerprint)


def _signal_daemon(conn, sig: signal.Signals, expected_token: Optional[str] = None) -> bool:
    """Send ``sig`` to the verified daemon pid, refusing on identity mismatch."""
    target = _verified_target(conn, expected_token=expected_token)
    if target is None:
        return False
    pid, _token, _fp = target
    try:
        os.kill(pid, sig)
        return True
    except OSError:
        return False


def _wait_for_ack(conn, request_id: int, timeout: float = ACK_TIMEOUT) -> bool:
    """Block until the daemon acks this flush row, or timeout.

    Returns True iff ``acknowledged_ts`` was set within the window. Callers
    that need the success/failure outcome should follow up with
    :func:`_ack_outcome`, which inspects ``status`` and the daemon-supplied
    note. Splitting "ack arrived" from "ack outcome" keeps existing callers
    that only care about presence simple, while letting blocking flush
    distinguish ``ok`` from ``failed``.
    """
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


def _ack_outcome(conn, request_id: int) -> Tuple[str, Optional[str]]:
    """Return ``(status, note)`` for an acknowledged flush row.

    Daemon-side ack paths surface failures two ways: explicitly via
    ``status='failed'`` (newer daemons that pass the status kwarg), or
    implicitly via a note that begins with ``"<command> acknowledged with
    error"`` (older daemons predating the schema bump). We treat either
    signal as failure so the blocking controller doesn't report ok=true on a
    capture/replay error. Rows we cannot read (deleted/pruned) are reported
    as ``status='unknown'`` rather than silently passing.
    """
    row = conn.execute(
        "SELECT status, note FROM flush_requests WHERE id=?",
        (request_id,),
    ).fetchone()
    if row is None:
        return "unknown", None
    status = str(row[0] or "")
    note = row[1]
    if status == "failed":
        return "failed", note
    if note and "acknowledged with error" in str(note):
        return "failed", str(note)
    return status or "acknowledged", note


def _settle_pending_requests(conn, note: str, request_id: int) -> None:
    """Settle the one request row created by the current controller command.

    Always scoped by ``request_id`` — the previous open-ended fallback that
    settled every unacknowledged row ran the risk of falsely closing
    concurrent flushes from other controllers, and had no remaining caller.
    """
    now = time.time()
    conn.execute(
        """UPDATE flush_requests
           SET acknowledged_ts=?, completed_ts=?, status='acknowledged',
               note=COALESCE(note, '') || ?
           WHERE id=? AND acknowledged_ts IS NULL""",
        (now, now, f"; {note}", request_id),
    )


def _record_flush(
    repo_root: Path, conn, non_blocking: bool
) -> Tuple[int, bool, str, bool, bool, Optional[str]]:
    """Insert the flush row and signal the daemon while we still hold control_lock.

    Returns ``(request_id, signaled, branch_ref, daemon_live, script_present, warning)``
    so callers can release the control_lock immediately and then wait for
    the ack in unlocked space. Holding control_lock across the (possibly
    30-second) ack wait used to starve every other controller command.

    ``daemon_live`` is true ONLY when ``_signal_daemon`` succeeded — i.e.
    there is a verified, reachable daemon that will actually ack the flush
    row. ``script_present`` indicates the daemon binary exists and so a
    fresh daemon could be spawned. The previous combined "daemon_present"
    flag conflated the two and caused blocking flushes against a crashed
    daemon to wait the full ACK_TIMEOUT for an ack nobody would write.
    """
    ctx = _light_context(repo_root)
    request_id = request_flush(conn, "flush", non_blocking, note="flush requested")
    signaled = _signal_daemon(conn, signal.SIGUSR1)
    script_present = daemon_script_path().exists()
    warning: Optional[str] = None
    if not signaled and not script_present:
        # No daemon and no way to spawn one: the flush row will sit
        # unacknowledged forever. Surface this rather than hang or pretend
        # success — the caller decides whether to error or warn.
        warning = "no daemon to honor flush; events recorded but not replayed"
    elif not signaled and script_present:
        # Script exists but no live daemon to ack: the row will sit
        # unacknowledged unless we spawn one. Surface this so the caller
        # can decide between spawn-and-wait and erroring out.
        warning = "no live daemon to ack flush; daemon script available for spawn"
    return request_id, signaled, ctx["branch_ref"], signaled, script_present, warning


class FlushFailedError(RuntimeError):
    """Raised when the daemon ack reports a capture/replay failure."""

    def __init__(self, note: Optional[str]) -> None:
        super().__init__(note or "daemon reported flush failure")
        self.note = note


def _await_flush_ack(conn, request_id: int) -> None:
    """Wait for ack outside ``control_lock``; raise on timeout/failure.

    A ``FlushFailedError`` is raised when the row arrives with a failure
    status (or a note that encodes a failure from older daemons) so the
    blocking flush can return non-zero rather than mis-report success.
    """
    if not _wait_for_ack(conn, request_id):
        raise TimeoutError("flush timed out waiting for daemon ack")
    status, note = _ack_outcome(conn, request_id)
    if status == "failed":
        raise FlushFailedError(note)


def cmd_wake(
    repo_root: Path, git_dir: Path, session_pid: Optional[int] = None
) -> int:
    conn = ensure_state(git_dir)
    try:
        with control_lock(git_dir):
            if session_pid:
                touch_client(conn, session_pid)
            ctx = _light_context(repo_root)
            request_id = request_flush(conn, "wake", True, note="wake requested")
            if not _signal_daemon(conn, signal.SIGUSR1):
                _maybe_start(repo_root, git_dir, conn, note="wake-start fallback")
            print(json.dumps({"ok": True, "action": "wake", "request_id": request_id, "branch": ctx["branch_ref"]}, indent=2))
            return 0
    except DetachedHeadError as exc:
        print(f"refusing to wake daemon: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def cmd_flush(
    repo_root: Path,
    git_dir: Path,
    non_blocking: bool,
    session_pid: Optional[int] = None,
) -> int:
    conn = ensure_state(git_dir)
    try:
        # Hold control_lock only for the request-row insert and signal
        # delivery. The ack wait happens outside the lock so a slow daemon
        # cannot starve concurrent wake/sleep/stop commands.
        with control_lock(git_dir):
            if session_pid:
                touch_client(conn, session_pid)
            request_id, signaled, branch, daemon_live, script_present, warning = _record_flush(
                repo_root, conn, non_blocking
            )
            if not daemon_live and script_present and not non_blocking:
                # Blocking flush against a non-live daemon: mirror cmd_wake
                # spawn-fallback so the row will actually be acked rather
                # than hanging for ACK_TIMEOUT. We attempt the spawn under
                # the same control_lock that wrote the request row.
                _maybe_start(repo_root, git_dir, conn, note="flush-start fallback")
                # Re-signal: a freshly bootstrapped daemon now owns the row.
                if _signal_daemon(conn, signal.SIGUSR1):
                    daemon_live = True
                    warning = None
        if non_blocking:
            payload: Dict[str, Any] = {
                "ok": True,
                "action": "flush",
                "non_blocking": True,
                "request_id": request_id,
                "signaled": signaled,
                "branch": branch,
            }
            if not daemon_live:
                # Non-blocking against a non-live daemon would silently
                # "succeed" while the row sits forever; surface a clear
                # error instead. Return code 2 distinguishes this from
                # success and from the blocking timeout path below.
                payload["ok"] = False
                payload["status"] = "degraded"
                payload["warning"] = warning or (
                    "no live daemon; non-blocking flush would not be acked"
                )
                print(json.dumps(payload, indent=2))
                return 2
            if warning:
                payload["warning"] = warning
            print(json.dumps(payload, indent=2))
            return 0
        if not daemon_live:
            print(
                f"flush degraded: {warning or 'no live daemon to ack flush'}",
                file=sys.stderr,
            )
            return 2
        try:
            _await_flush_ack(conn, request_id)
        except TimeoutError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        except FlushFailedError as exc:
            # The daemon acked the row but capture/replay raised. Returning
            # ok=true here would silently swallow data-loss; surface the
            # failure with a non-zero exit so callers can react.
            print(
                json.dumps(
                    {
                        "ok": False,
                        "action": "flush",
                        "request_id": request_id,
                        "branch": branch,
                        "status": "failed",
                        "error": exc.note or str(exc),
                    },
                    indent=2,
                ),
                file=sys.stderr,
            )
            return 2
        print(json.dumps({"ok": True, "action": "flush", "request_id": request_id, "branch": branch}, indent=2))
        return 0
    except DetachedHeadError as exc:
        print(f"refusing to flush: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def cmd_sleep(
    repo_root: Path, git_dir: Path, session_pid: Optional[int] = None
) -> int:
    conn = ensure_state(git_dir)
    try:
        with control_lock(git_dir):
            if session_pid:
                touch_client(conn, session_pid)
            ctx = _light_context(repo_root)
            request_id = request_flush(conn, "sleep", True, note="sleep requested")
            _signal_daemon(conn, signal.SIGUSR1)
            _refresh_mode(conn, "sleeping", note="sleep requested")
            print(json.dumps({"ok": True, "action": "sleep", "request_id": request_id, "branch": ctx["branch_ref"]}, indent=2))
            return 0
    except DetachedHeadError as exc:
        print(f"refusing to sleep daemon: {exc}", file=sys.stderr)
        return 1
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


def cmd_stop(
    repo_root: Path,
    git_dir: Path,
    flush_first: bool,
    session_pid: Optional[int] = None,
    force: bool = False,
) -> int:
    """Stop the daemon, optionally flushing first.

    With multi-session refcount enabled (the default), stop is per-session:
    deregister the calling pi from ``daemon_clients`` and let the daemon
    self-terminate via its periodic GC sweep once every other registered
    session has also exited. ``--force`` restores the legacy behaviour and
    kills the daemon outright regardless of peer sessions, drains queued
    work first when ``--flush`` is also set.

    Behaviour matrix:
      - peer sessions remain (refcount > 1) → deregister, signal a
        graceful flush, do NOT kill the daemon. Reports ``deferred=True``.
      - last session (refcount drops to 0)  → deregister, behave as before
        (drain + SIGTERM + verify).
      - ``--force``                          → ignore refcount, kill anyway.
    """
    conn = ensure_state(git_dir)
    try:
        # ---- Deferred-stop path (refcount > 0 after our deregister) -----
        #
        # If a session_pid was supplied and we are NOT forcing, hand the stop
        # decision back to the daemon: deregister our row, GC stale peers,
        # and return early when peers remain. The daemon's own sweep tick
        # exits the process when ``daemon_clients`` empties, so this single
        # session's exit cannot drag the daemon out from under siblings.
        if session_pid and not force:
            deferred_remaining = 0
            deferred_flush_id: Optional[int] = None
            with control_lock(git_dir):
                ctx_deferred = _light_context(repo_root)
                deregister_client(conn, session_pid)
                gc_dead_clients(conn)
                deferred_remaining = client_count(conn)
                if deferred_remaining > 0 and flush_first:
                    deferred_flush_id = request_flush(
                        conn,
                        "flush",
                        False,
                        note="flush requested before deferred stop",
                    )
                    _signal_daemon(conn, signal.SIGUSR1)
            if deferred_remaining > 0:
                # Outside the control lock so a slow daemon doesn't starve
                # other controllers waiting on the same lock.
                if deferred_flush_id is not None:
                    try:
                        _await_flush_ack(conn, deferred_flush_id)
                    except TimeoutError as exc:
                        print(str(exc), file=sys.stderr)
                    except FlushFailedError as exc:
                        print(
                            f"deferred-stop flush reported failure: {exc.note or exc}",
                            file=sys.stderr,
                        )
                payload = {
                    "ok": True,
                    "action": "stop",
                    "deferred": True,
                    "session_pid": session_pid,
                    "remaining_clients": deferred_remaining,
                    "branch": ctx_deferred["branch_ref"],
                    "flush_request_id": deferred_flush_id,
                    "flushed": flush_first,
                }
                print(
                    json.dumps(payload, indent=2, sort_keys=True, default=str)
                )
                return 0

        # ---- Last-session-out / forced-stop path ------------------------
        with control_lock(git_dir):
            ctx = _light_context(repo_root)
            flush_request_id: Optional[int] = None
            flush_warning: Optional[str] = None
            # Verify daemon presence before recording the pre-stop flush row.
            # Otherwise a `stop --flush` against an already-dead daemon
            # leaves an unacknowledged row stranded forever — that row keeps
            # accumulating in flush_requests and confuses status counters.
            target = _verified_target(conn)
            if flush_first:
                if target is not None:
                    (
                        flush_request_id,
                        _signaled,
                        _branch,
                        _live,
                        _script_present,
                        flush_warning,
                    ) = _record_flush(repo_root, conn, non_blocking=False)
                else:
                    flush_warning = "no daemon present; skipping pre-stop flush"
            request_id = request_flush(conn, "stop", False, note="stop requested")
            row = _daemon_row(conn)
            cached_token = row.get("daemon_token")
            cached_fingerprint = row.get("daemon_fingerprint")
            pid = target[0] if target else int(row.get("pid") or 0)
            lock_fp = snapshot_state.lock_path(git_dir)

        # Outside control_lock: wait for the optional preceding flush ack so
        # we don't starve other controllers waiting on the same lock.
        if flush_first and flush_request_id is not None:
            try:
                _await_flush_ack(conn, flush_request_id)
            except TimeoutError as exc:
                print(str(exc), file=sys.stderr)
            except FlushFailedError as exc:
                print(
                    f"flush prior to stop reported failure: {exc.note or exc}",
                    file=sys.stderr,
                )

        if target is None:
            _settle_pending_requests(conn, "stop acknowledged; daemon absent or unverified", request_id=request_id)
            with control_lock(git_dir):
                _refresh_mode(conn, "stopped", note="stop requested")
            print(json.dumps({"ok": True, "action": "stop", "request_id": request_id, "branch": ctx["branch_ref"], "flushed": flush_first}, indent=2))
            return 0

        # Send SIGUSR1 to encourage a clean drain. Re-verify identity each
        # time before escalating, so a daemon that exited and had its PID
        # recycled mid-stop never receives our signal.
        _signal_daemon(conn, signal.SIGUSR1, expected_token=cached_token)
        _wait_for_ack(conn, request_id)

        # Re-verify fingerprint *and* the row's current pid before SIGTERM.
        # ``_verified_target`` only checks the row's *current* pid against
        # its fingerprint; if the daemon exited cleanly (no heartbeat) the
        # captured ``pid`` may now belong to an unrelated process via PID
        # reuse. Three outcomes:
        #
        # * Daemon already gone (no heartbeat) → skip SIGTERM, fall
        #   through to the exit-wait. This is the clean-shutdown path.
        # * Pid is alive AND fingerprint matches AND row still names this
        #   pid → safe to SIGTERM the captured pid.
        # * Pid is alive but fingerprint or row-pid mismatches → refuse
        #   to signal: SIGTERMing a recycled pid would hit a stranger.
        if not heartbeat_alive(pid):
            sigterm_decision = "skip"
        else:
            current_row = _daemon_row(conn)
            current_pid = int(current_row.get("pid") or 0)
            identity_ok = bool(
                cached_fingerprint
                and verify_process_identity(pid, str(cached_fingerprint))
            )
            row_ok = (current_pid == pid) or current_pid == 0
            sigterm_decision = "send" if identity_ok and row_ok else "refuse"
        if sigterm_decision == "send":
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        elif sigterm_decision == "refuse":
            current_row = _daemon_row(conn)
            with control_lock(git_dir):
                set_daemon_state(
                    conn,
                    pid=int(current_row.get("pid") or 0),
                    mode=str(current_row.get("mode") or "stopped"),
                    branch_ref=current_row.get("branch_ref"),
                    branch_generation=current_row.get("branch_generation"),
                    note=f"refused SIGTERM to pid {pid}: identity mismatch",
                )
            _settle_pending_requests(
                conn,
                f"stop refused: pid {pid} fingerprint mismatch",
                request_id=request_id,
            )
            print(
                json.dumps(
                    {
                        "ok": False,
                        "action": "stop",
                        "request_id": request_id,
                        "branch": ctx["branch_ref"],
                        "error": "refused to signal pid: identity mismatch",
                        "pid": pid,
                    },
                    indent=2,
                ),
                file=sys.stderr,
            )
            return 1
        # sigterm_decision == "skip": daemon already exited cleanly

        if not _wait_for_exit(pid, lock_fp, ACK_TIMEOUT):
            # Re-verify fingerprint before SIGKILL: if the original daemon
            # is gone and the PID was reused, refuse to escalate. Without
            # this re-check, escalation could SIGKILL an unrelated process.
            if (
                cached_fingerprint
                and verify_process_identity(pid, str(cached_fingerprint))
                and heartbeat_alive(pid)
            ):
                try:
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
        with control_lock(git_dir):
            _refresh_mode(conn, "stopped", note="stop requested")
        print(json.dumps({"ok": True, "action": "stop", "request_id": request_id, "branch": ctx["branch_ref"], "flushed": flush_first}, indent=2))
        return 0
    except DetachedHeadError as exc:
        print(f"refusing to stop: {exc}", file=sys.stderr)
        return 1
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
    parser.add_argument(
        "--session-pid",
        type=int,
        default=None,
        help=(
            "PID of the pi-harness session calling this controller. "
            "Used for the daemon-client refcount so the daemon only "
            "self-terminates once every registered session has exited. "
            "Falls back to $PI_SESSION_PID, then a parent-process walk."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=(
            "stop only: ignore the daemon-client refcount and kill the "
            "daemon outright regardless of peer pi sessions."
        ),
    )
    args = parser.parse_args(argv)

    repo_input = Path(args.repo).expanduser()
    try:
        repo_root, git_dir, _common = resolve_repo_paths(repo_input)
        if args.git_dir:
            git_dir = Path(args.git_dir).expanduser().resolve()
    except Exception as exc:
        print(f"not a git repository: {exc}", file=sys.stderr)
        return 1

    session_pid = _resolve_session_pid(args.session_pid)

    if args.command == "start":
        return cmd_start(repo_root, git_dir, session_pid=session_pid)
    if args.command == "wake":
        return cmd_wake(repo_root, git_dir, session_pid=session_pid)
    if args.command == "flush":
        return cmd_flush(
            repo_root,
            git_dir,
            non_blocking=args.non_blocking,
            session_pid=session_pid,
        )
    if args.command == "sleep":
        return cmd_sleep(repo_root, git_dir, session_pid=session_pid)
    if args.command == "stop":
        return cmd_stop(
            repo_root,
            git_dir,
            flush_first=args.flush,
            session_pid=session_pid,
            force=args.force,
        )
    return cmd_status(repo_root, git_dir)


if __name__ == "__main__":
    sys.exit(main())

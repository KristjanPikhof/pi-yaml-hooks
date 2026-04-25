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


def _clamp(value: float, *, minimum: float, name: str) -> float:
    """Clamp env-var floats so a typo cannot turn into a denial-of-service.

    A bare ``=0`` would otherwise either peg CPU (poll intervals) or
    immediately wipe the queue (retention). Clamping with a clear message in
    daemon_meta is friendlier than silent disaster.
    """
    if value < minimum:
        return minimum
    return value


POLL_INTERVAL = _clamp(
    float(os.environ.get("SNAPSHOTD_POLL_INTERVAL", "0.75")),
    minimum=0.05,
    name="SNAPSHOTD_POLL_INTERVAL",
)
SLEEP_INTERVAL = _clamp(
    float(os.environ.get("SNAPSHOTD_SLEEP_INTERVAL", "2.0")),
    minimum=0.05,
    name="SNAPSHOTD_SLEEP_INTERVAL",
)
RETENTION_DAYS = _clamp(
    float(os.environ.get("SNAPSHOTD_RETENTION_DAYS", "7")),
    minimum=0.5,
    name="SNAPSHOTD_RETENTION_DAYS",
)
PRUNE_INTERVAL_SECONDS = 60.0
# Adaptive idle backoff: when nothing has changed for many ticks we ramp the
# poll interval up to this ceiling so an idle daemon doesn't dominate I/O on
# a 50k-file worktree. Active ticks (any classification, any flush) reset.
IDLE_BACKOFF_CEILING = _clamp(
    float(os.environ.get("SNAPSHOTD_IDLE_BACKOFF_CEILING", "30.0")),
    minimum=POLL_INTERVAL,
    name="SNAPSHOTD_IDLE_BACKOFF_CEILING",
)
# Exponential backoff after capture failures so a persistent disk-full /
# corrupt-object error doesn't peg the CPU retrying every 0.75s.
CAPTURE_ERROR_BACKOFF_MAX = _clamp(
    float(os.environ.get("SNAPSHOTD_CAPTURE_ERROR_BACKOFF_MAX", "60.0")),
    minimum=POLL_INTERVAL,
    name="SNAPSHOTD_CAPTURE_ERROR_BACKOFF_MAX",
)


def _load_path_module(name: str, filename: str):
    """Load a Python module from disk, registering it in ``sys.modules``.

    Registration matters when the loaded module re-imports another that's
    also disk-loaded — without it, each import creates a fresh module
    instance, which silently breaks any module-level cache (`_STAT_CACHE`,
    counters) by making it per-call instead of per-process.
    """
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, str(HERE / filename))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


capture = _load_path_module("snapshot_capture", "snapshot-capture.py")
# Hoisted to module scope so each flush/stop tick does NOT re-`exec_module`
# a 575-line module. The previous form re-loaded it on every request — fine
# correctness-wise today, but a latency tax that scaled with hook count and
# a latent bug for any future module-level state in snapshot-replay.
replay = _load_path_module("snapshot_replay", "snapshot-replay.py")


def _request_rows(conn):
    return conn.execute(
        "SELECT id, command, non_blocking FROM flush_requests WHERE acknowledged_ts IS NULL ORDER BY id"
    ).fetchall()


def _ack(conn, request_id: int, note: str = "") -> None:
    snapshot_state.acknowledge_flush(conn, request_id, note)


def _replay_pending(conn, repo_root: Path, git_dir: Path) -> int:
    return int(replay.replay_pending_events(conn, repo_root, git_dir))


def _pending_event_count(conn) -> int:
    row = conn.execute("SELECT COUNT(*) FROM capture_events WHERE state='pending'").fetchone()
    return int(row[0] if row else 0)


# Errors recorded *inside* poll_once (e.g. ``_IgnoreCheckFailed``) are
# tagged with this prefix so the daemon loop can distinguish "poll_once
# returned cleanly, clear the previous tick's error" from "poll_once
# returned cleanly but caught an internal failure and wrote a real error
# we must NOT silently overwrite." Keep this string in sync with the
# matching prefix in ``snapshot-capture.py::poll_once``.
_POLL_ONCE_INTERNAL_ERROR_PREFIXES = (
    "check-ignore:",
    "bootstrap:",
    "head-baseline:",
)


def _poll_once_wrote_internal_error(conn) -> bool:
    """Return True if poll_once just recorded an internal-error meta value.

    The daemon loop calls this after a successful ``poll_once`` return — a
    True result means "a real error was caught internally; do NOT clear
    last_capture_error to empty, that would mask the failure."
    """
    current = snapshot_state.get_daemon_meta(conn, "last_capture_error") or ""
    return any(current.startswith(prefix) for prefix in _POLL_ONCE_INTERNAL_ERROR_PREFIXES)


def _capture_then_replay(conn, repo_root: Path, git_dir: Path) -> int:
    """Capture the current stable polling snapshot before draining commits."""
    try:
        capture.poll_once(conn, repo_root, git_dir)
        # poll_once may have caught an internal failure (bootstrap,
        # head-baseline, check-ignore) and written a typed error to
        # ``last_capture_error`` while still returning []. Only clear here
        # when the meta value did NOT come from that internal-error path,
        # otherwise this blanket-clear masks the real failure. When it did
        # come from there, surface it as an exception so blocking flushes
        # ack with a non-zero status carrying the error text.
        if _poll_once_wrote_internal_error(conn):
            internal_err = (
                snapshot_state.get_daemon_meta(conn, "last_capture_error")
                or "internal capture error"
            )
            raise RuntimeError(internal_err)
        snapshot_state.set_daemon_meta(conn, "last_capture_error", "")
    except Exception as exc:
        snapshot_state.set_daemon_meta(conn, "last_capture_error", str(exc))
        raise
    return _replay_pending(conn, repo_root, git_dir) if _pending_event_count(conn) else 0


def _safe_capture_then_replay(
    conn, repo_root: Path, git_dir: Path
) -> Tuple[int, Optional[str]]:
    """Run capture+replay, never propagating exceptions to the daemon loop.

    A propagated exception used to crash the daemon mid-loop and leave any
    queued flush/stop rows un-acked, so controllers timed out for 30s with
    "flush timed out waiting for daemon ack". Now we trap, record, and
    return the error string so callers can ack with the failure note.
    """
    try:
        return _capture_then_replay(conn, repo_root, git_dir), None
    except Exception as exc:  # noqa: BLE001 — boundary catch is intentional
        try:
            snapshot_state.set_daemon_meta(conn, "last_replay_error", str(exc))
            conn.commit()
        except Exception:
            pass
        return 0, str(exc)


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
    ack note so N queued flushes cost O(1) work instead of N. Failures
    inside capture/replay are surfaced via the ack note rather than killing
    the daemon, so a transient git error cannot strand controllers.

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

    if flush_ids:
        published, err = _safe_capture_then_replay(conn, repo_root, git_dir)
        if err is None:
            flush_note = (
                f"flush acknowledged; published={published}; coalesced={len(flush_ids)}"
            )
        else:
            flush_note = f"flush acknowledged with error; coalesced={len(flush_ids)}; error={err}"
        # Atomic batch: a crash mid-loop must not leave half the coalesced
        # acks recorded and half pending — controllers would see a flush
        # "succeed" while their sibling timed out.
        with snapshot_state.transaction(conn):
            for rid in flush_ids:
                _ack(conn, rid, flush_note)

    if stop_ids:
        # Stop does its own final capture+replay so any work queued after the
        # flush cycle still lands before shutdown. We always honor the stop
        # request even if the final capture errors — the alternative is the
        # controller timing out and the daemon being SIGKILLed anyway.
        published, err = _safe_capture_then_replay(conn, repo_root, git_dir)
        if err is None:
            stop_note = (
                f"stop acknowledged; published={published}; coalesced={len(stop_ids)}"
            )
        else:
            stop_note = f"stop acknowledged with error; coalesced={len(stop_ids)}; error={err}"
        with snapshot_state.transaction(conn):
            for rid in stop_ids:
                _ack(conn, rid, stop_note)
        sleeping = True
        stop_event.set()

    if other:
        # Same all-or-nothing invariant for wake/sleep/unknown commands.
        with snapshot_state.transaction(conn):
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


def _next_idle_interval(consecutive_idle_ticks: int) -> float:
    """Exponential backoff for idle ticks, bounded by the configured ceiling.

    Past ~6 idle ticks at base 0.75s we hit the ceiling and stay there until
    the next active tick resets us. A SIGUSR1 wake jumps out of the sleep
    immediately via wake_event.
    """
    if consecutive_idle_ticks <= 0:
        return POLL_INTERVAL
    interval = POLL_INTERVAL * (2 ** min(consecutive_idle_ticks, 8))
    return min(interval, IDLE_BACKOFF_CEILING)


def _next_error_interval(consecutive_errors: int) -> float:
    """Exponential backoff after capture failures so a persistent disk-full
    or corrupt-object error doesn't peg the CPU retrying every poll tick.
    """
    if consecutive_errors <= 0:
        return POLL_INTERVAL
    interval = POLL_INTERVAL * (2 ** min(consecutive_errors, 8))
    return min(interval, CAPTURE_ERROR_BACKOFF_MAX)


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
            # Another daemon holds the flock. We are NOT the live daemon, so
            # we must not write our own pid / token / fingerprint into the
            # singleton daemon_state row — doing so would clobber the live
            # peer's identity and could fool controllers into signaling THIS
            # process (which is about to exit) instead of the real daemon.
            # The peer's own heartbeat is the source of truth; we exit with
            # EX_TEMPFAIL so the caller can distinguish "peer running" from
            # "started cleanly". A stalled-but-flock-holding peer is a kernel
            # invariant — flock is released on process exit — so we treat
            # the contention as "peer alive" by definition.
            return EX_TEMPFAIL

        daemon_token = _new_daemon_token()
        # Bind the daemon's identity to an OS-level fingerprint (process
        # start time + argv). Controllers compare this against the live
        # process before signaling, which closes the PID-reuse window the
        # bare token check left open.
        daemon_fingerprint = snapshot_state.process_fingerprint(os.getpid())

        try:
            ctx = snapshot_state.repo_context(repo_root, git_dir)
        except snapshot_state.DetachedHeadError as exc:
            print(f"snapshot-daemon refusing to start: {exc}", file=sys.stderr)
            return 1
        # Bootstrap can be many seconds on real repos — advertise a
        # 'bootstrapping' heartbeat now so controllers waiting on readiness
        # don't time out before the initial shadow scan finishes.
        snapshot_state.set_daemon_state(
            conn,
            pid=os.getpid(),
            mode="bootstrapping",
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            note="bootstrapping shadow tree",
            daemon_token=daemon_token,
            daemon_fingerprint=daemon_fingerprint,
        )
        conn.commit()
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
            # Also wake the sleep loop so SIGTERM/SIGINT exits in O(0)
            # instead of waiting up to ``interval`` seconds for the next
            # poll tick. Setting wake_event here is safe because the loop
            # checks stop_event immediately after waking.
            wake_event.set()

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
            daemon_fingerprint=daemon_fingerprint,
        )
        conn.commit()
        last_prune = 0.0
        consecutive_idle_ticks = 0
        consecutive_capture_errors = 0

        while not stop_event.is_set():
            if wake_event.is_set():
                sleeping = False
                wake_event.clear()

            had_request_rows = bool(_request_rows(conn))
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

            produced_events = 0
            if not sleeping:
                try:
                    seqs = capture.poll_once(conn, repo_root, git_dir)
                    produced_events = len(seqs) if seqs else 0
                    # poll_once may have returned [] AND recorded an internal
                    # error (bootstrap, head-baseline, or check-ignore failure)
                    # via daemon_meta.last_capture_error. Unconditionally
                    # clearing here would mask that. Mirror the guard used by
                    # _capture_then_replay so the error survives until the
                    # underlying issue clears.
                    if _poll_once_wrote_internal_error(conn):
                        internal_err = (
                            snapshot_state.get_daemon_meta(conn, "last_capture_error")
                            or "internal capture error"
                        )
                        consecutive_capture_errors += 1
                        snapshot_state.set_daemon_meta(
                            conn,
                            "consecutive_capture_errors",
                            str(consecutive_capture_errors),
                        )
                        _heartbeat(
                            conn,
                            os.getpid(),
                            "running",
                            ctx,
                            note=f"capture error #{consecutive_capture_errors}: {internal_err}",
                        )
                    else:
                        snapshot_state.set_daemon_meta(conn, "last_capture_error", "")
                        snapshot_state.set_daemon_meta(
                            conn, "consecutive_capture_errors", "0"
                        )
                        consecutive_capture_errors = 0
                except Exception as exc:
                    consecutive_capture_errors += 1
                    snapshot_state.set_daemon_meta(conn, "last_capture_error", str(exc))
                    snapshot_state.set_daemon_meta(
                        conn,
                        "consecutive_capture_errors",
                        str(consecutive_capture_errors),
                    )
                    _heartbeat(
                        conn,
                        os.getpid(),
                        "running",
                        ctx,
                        note=f"capture error #{consecutive_capture_errors}: {exc}",
                    )
                conn.commit()

            now_wall = time.time()
            if (now_wall - last_prune) >= PRUNE_INTERVAL_SECONDS:
                try:
                    snapshot_state.prune_expired(
                        conn,
                        retention_seconds=RETENTION_DAYS * 86400.0,
                    )
                    conn.commit()
                    snapshot_state.set_daemon_meta(conn, "last_prune_error", "")
                except Exception as exc:
                    snapshot_state.set_daemon_meta(conn, "last_prune_error", str(exc))
                    conn.commit()
                last_prune = now_wall

            if had_request_rows or produced_events > 0:
                consecutive_idle_ticks = 0
            else:
                consecutive_idle_ticks += 1

            if sleeping:
                interval = SLEEP_INTERVAL
            elif consecutive_capture_errors > 0:
                interval = _next_error_interval(consecutive_capture_errors)
            else:
                interval = _next_idle_interval(consecutive_idle_ticks)
            # Single cancellable sleep: returns early when SIGUSR1 / SIGTERM /
            # SIGINT fire (both stop and wake handlers set wake_event), and
            # otherwise blocks for the full interval without spinning the
            # CPU on a 0.1s poll loop. The previous form woke 600 times for
            # a 60-second sleep just to re-check two flags.
            wake_event.wait(timeout=interval)

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

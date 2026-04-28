"""Regression tests for snapshot-daemonctl.py findings P1, P2, P3.

These cover the controller-side fixes only — the daemon process itself is
substituted with synthesized DB rows so the assertions stay deterministic
and don't depend on subprocess timing.
"""
from __future__ import annotations

import sys
import time
import unittest
from io import StringIO
from pathlib import Path
from unittest import mock

EXAMPLE_DIR = Path(__file__).resolve().parents[1]
TESTS_DIR = Path(__file__).resolve().parent
if str(EXAMPLE_DIR) not in sys.path:
    sys.path.insert(0, str(EXAMPLE_DIR))
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import snapshot_state  # noqa: E402

from test_worktree_daemon import init_repo, load_example_module  # noqa: E402


def _stamp_running_daemon(conn, pid: int, fingerprint: str = "fake-fp") -> str:
    """Synthesize a daemon_state row that ``_verified_target`` accepts.

    Returns the token used so callers can assert against it.
    """
    token = "tok-" + str(pid)
    snapshot_state.set_daemon_state(
        conn,
        pid=pid,
        mode="running",
        branch_ref="refs/heads/main",
        branch_generation=1,
        note="synthesized for ctl-lane test",
        daemon_token=token,
        daemon_fingerprint=fingerprint,
    )
    conn.commit()
    return token


class CtlLaneRegressionTests(unittest.TestCase):
    """Pin the three ctl-lane fixes against silent regression."""

    # ------------------------------------------------------------------ P1
    def test_blocking_flush_returns_nonzero_on_daemon_failure(self) -> None:
        """Blocking flush must return non-zero when the daemon ack reports failure.

        Models the scenario where snapshot-daemon.py caught an exception
        inside ``_safe_capture_then_replay`` and acked the row with a
        failure note. Before the fix, the controller saw ``acknowledged_ts``
        set and reported ``ok=true`` regardless — a silent data-loss bug.
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        daemonctl = load_example_module("snapshot_daemonctl_p1", "snapshot-daemonctl.py")
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        # Pretend a daemon is alive by pointing at our own PID with a
        # matching fingerprint. ``verify_process_identity`` calls
        # ``process_fingerprint`` against the stored value, so we capture
        # the live one and stamp it.
        fp = snapshot_state.process_fingerprint(None)
        assert fp is not None
        _stamp_running_daemon(conn, pid=1234, fingerprint=fp)

        # Patch _signal_daemon so we don't actually try to kill pid=1234.
        # In its place, write a "failed" ack that mimics what the daemon
        # records when capture/replay raises.
        def fake_signal(_conn, _sig, **_kw):
            row = _conn.execute(
                "SELECT id FROM flush_requests WHERE acknowledged_ts IS NULL ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if row is None:
                return False
            request_id = int(row[0])
            # Write the failure ack directly (mimics the new daemon path
            # that passes status='failed') AND the legacy note format
            # ('acknowledged with error') so we cover both detection paths
            # in a single regression test.
            snapshot_state.acknowledge_flush(
                _conn,
                request_id,
                note="flush acknowledged with error; coalesced=1; error=disk full",
                status="failed",
            )
            return True

        with mock.patch.object(daemonctl, "_signal_daemon", side_effect=fake_signal), \
             mock.patch.object(daemonctl, "_verified_target", return_value=(1234, "tok-1234", fp)):
            captured_err = StringIO()
            with mock.patch("sys.stderr", captured_err):
                rc = daemonctl.cmd_flush(repo, git_dir, non_blocking=False)
        self.assertEqual(rc, 2, "expected non-zero exit on daemon-side failure")
        self.assertIn("failed", captured_err.getvalue())

        # Independently confirm the row carries the failure status so the
        # regression triggers even if the controller logic moves around.
        row = conn.execute(
            "SELECT status, note FROM flush_requests ORDER BY id DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(row[0], "failed")
        self.assertIn("disk full", row[1] or "")

    # ------------------------------------------------------------------ P1b
    def test_blocking_flush_detects_legacy_error_note(self) -> None:
        """A pre-schema-bump ack that only sets ``status='acknowledged'`` plus
        a note containing 'acknowledged with error' must still register as
        failed. This protects users running an older daemon against a newer
        controller — the failure must not be papered over.
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        daemonctl = load_example_module("snapshot_daemonctl_p1b", "snapshot-daemonctl.py")
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        fp = snapshot_state.process_fingerprint(None)
        assert fp is not None
        _stamp_running_daemon(conn, pid=4321, fingerprint=fp)

        def legacy_signal(_conn, _sig, **_kw):
            row = _conn.execute(
                "SELECT id FROM flush_requests WHERE acknowledged_ts IS NULL ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if row is None:
                return False
            request_id = int(row[0])
            # Legacy format: status defaults to 'acknowledged', failure
            # only encoded in the note string.
            snapshot_state.acknowledge_flush(
                _conn,
                request_id,
                note="flush acknowledged with error; coalesced=2; error=replay refused",
            )
            return True

        with mock.patch.object(daemonctl, "_signal_daemon", side_effect=legacy_signal), \
             mock.patch.object(daemonctl, "_verified_target", return_value=(4321, "tok-4321", fp)):
            captured_err = StringIO()
            with mock.patch("sys.stderr", captured_err):
                rc = daemonctl.cmd_flush(repo, git_dir, non_blocking=False)
        self.assertEqual(rc, 2)
        self.assertIn("replay refused", captured_err.getvalue())

    # ------------------------------------------------------------------ P2
    def test_stop_flush_with_no_daemon_does_not_strand_row(self) -> None:
        """stop --flush against a missing daemon must not leave an unacked row.

        Pre-fix: ``_record_flush`` ran unconditionally and wrote a flush row
        that nothing would ever ack — a slow leak that grew with each call.
        Post-fix: we skip the flush row entirely when ``_verified_target``
        returns None.
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        daemonctl = load_example_module("snapshot_daemonctl_p2", "snapshot-daemonctl.py")
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        # Deliberately do NOT stamp a daemon row. _verified_target should
        # return None and the stop path must take its no-daemon branch.
        before = int(
            conn.execute("SELECT COUNT(*) FROM flush_requests").fetchone()[0]
        )
        rc = daemonctl.cmd_stop(repo, git_dir, flush_first=True)
        self.assertEqual(rc, 0)

        rows = conn.execute(
            "SELECT command, acknowledged_ts FROM flush_requests ORDER BY id"
        ).fetchall()
        # We expect either (a) only the 'stop' row, settled by
        # _settle_pending_requests, or (b) a flush row and a stop row, both
        # acknowledged. The bug is "any row left unacked" — assert against
        # that directly.
        unacked = [
            dict(r) for r in rows
            if r["acknowledged_ts"] is None
        ]
        self.assertEqual(unacked, [], f"stop --flush left unacked rows: {unacked}")

        # And the cleanest implementation produces exactly one new row (the
        # stop request) — assert that to pin the chosen approach.
        after = int(
            conn.execute("SELECT COUNT(*) FROM flush_requests").fetchone()[0]
        )
        self.assertEqual(
            after - before,
            1,
            "expected exactly the stop row to be inserted when no daemon is present",
        )

    # ------------------------------------------------------------------ P3
    def test_maybe_start_peer_race_is_not_misreported_as_exit(self) -> None:
        """A peer-handoff during startup must not be reported as a daemon crash.

        Models the race window where ``_spawn_daemon`` returns a child that
        immediately exits because a peer already holds the flock. The peer
        will write its row, but possibly a few ms after our spawn polled.
        The fix adds a bounded retry so the peer row can become visible
        before we wrongly conclude the daemon exited during startup.
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        daemonctl = load_example_module("snapshot_daemonctl_p3", "snapshot-daemonctl.py")
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        peer_pid = 99999
        fp = "synthetic-peer-fp"

        # The fake spawned child: returns immediately as if it lost the flock.
        class _FakeProc:
            pid = 12345

            def poll(self):
                return 1  # already exited

        # Our spawn returns the fake child but DELAYS the peer's heartbeat
        # write — simulating the race where the peer's row appears slightly
        # after our poll. The first re-read should miss it; the second or
        # third (driven by the new bounded retry) should catch it.
        write_at = [time.time() + 0.07]

        def delayed_peer_visible(_row):
            # Simulate "peer's heartbeat is fresh" only after ``write_at``.
            heartbeat_ts = float(_row.get("heartbeat_ts") or 0)
            pid = int(_row.get("pid") or 0)
            if pid == peer_pid and time.time() >= write_at[0]:
                return (time.time() - heartbeat_ts) < 60.0
            return False

        # Pre-stamp the peer row so _daemon_row returns it. The race is
        # modeled by patching _fresh_heartbeat to lie until ``write_at``.
        snapshot_state.set_daemon_state(
            conn,
            pid=peer_pid,
            mode="running",
            branch_ref="refs/heads/main",
            branch_generation=1,
            note="peer daemon",
            daemon_token="peer-tok",
            daemon_fingerprint=fp,
        )
        conn.commit()

        with mock.patch.object(daemonctl, "_spawn_daemon", return_value=_FakeProc()), \
             mock.patch.object(daemonctl, "_fresh_heartbeat", side_effect=delayed_peer_visible):
            result = daemonctl._maybe_start(repo, git_dir, conn, note="test")
        self.assertEqual(
            result.get("reason"),
            "peer daemon already running",
            f"expected peer-detected outcome, got {result}",
        )
        self.assertFalse(result.get("started"))


class StopRefcountDeferralTests(unittest.TestCase):
    """v5: ``cmd_stop`` deregisters the calling session and defers the
    actual kill while peer sessions remain. The daemon's own GC sweep
    handles termination once every registered session has exited.

    These tests pin the controller-side refcount logic without spawning a
    real daemon — the focus is "does cmd_stop kill or defer?".
    """

    def test_stop_with_peer_session_defers_kill(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        daemonctl = load_example_module(
            "snapshot_daemonctl_refcount_defer", "snapshot-daemonctl.py"
        )
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        # Two registered pi sessions: this test process and a synthesized
        # "peer" session whose pid is also alive (we reuse the test pid for
        # both via two distinct fingerprints — the GC accepts whichever
        # row's fingerprint matches the live pid). To make the peer survive
        # GC, we register it under THIS process's real fingerprint with a
        # synthetic positive pid distinct from os.getpid(). Easiest: use
        # the parent PID. As long as ppid != current pid and is alive, it
        # passes liveness; we register it under its real fingerprint too.
        import os as _os
        own_pid = _os.getpid()
        own_fp = snapshot_state.process_fingerprint(own_pid)
        ppid = _os.getppid()
        ppid_fp = snapshot_state.process_fingerprint(ppid)
        self.assertNotEqual(own_pid, ppid)
        self.assertIsNotNone(own_fp)
        self.assertIsNotNone(ppid_fp)

        snapshot_state.register_client(conn, own_pid, str(own_fp))
        snapshot_state.register_client(conn, ppid, str(ppid_fp))
        self.assertEqual(snapshot_state.client_count(conn), 2)

        # Stamp a fake daemon row so _verified_target would otherwise pass.
        token = _stamp_running_daemon(conn, pid=98765, fingerprint="real-fp")
        self.assertTrue(token)

        # The deferred path should NOT signal or kill the daemon. Patch
        # os.kill to capture lethal signals — sig=0 is a liveness probe
        # used by ``heartbeat_alive`` and must be allowed through to the
        # real os.kill so the probe still works during the test.
        import os as _os_for_kill
        import signal as _sig
        kill_calls = []
        real_kill = _os_for_kill.kill

        def _capture_kill(pid, sig):
            if sig == 0:
                return real_kill(pid, sig)
            kill_calls.append((pid, sig))
            return None

        captured = StringIO()
        with mock.patch.object(daemonctl.os, "kill", side_effect=_capture_kill), \
             mock.patch("sys.stdout", captured):
            rc = daemonctl.cmd_stop(
                repo,
                git_dir,
                flush_first=False,
                session_pid=own_pid,
            )
        self.assertEqual(rc, 0)

        import json as _json
        payload = _json.loads(captured.getvalue())
        self.assertTrue(payload.get("deferred"), payload)
        self.assertEqual(payload.get("remaining_clients"), 1)
        self.assertEqual(payload.get("session_pid"), own_pid)
        # Critical: no SIGTERM/SIGKILL was sent.
        self.assertEqual(kill_calls, [])
        # Calling session was removed; peer remains.
        remaining = {row["pid"] for row in snapshot_state.list_clients(conn)}
        self.assertEqual(remaining, {ppid})

    def test_stop_force_ignores_refcount(self) -> None:
        """``--force`` short-circuits the refcount and follows the legacy
        kill path. Used as the operator-explicit escape hatch."""
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        daemonctl = load_example_module(
            "snapshot_daemonctl_refcount_force", "snapshot-daemonctl.py"
        )
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        # Register a peer session that would normally defer the stop.
        import os as _os
        ppid = _os.getppid()
        ppid_fp = snapshot_state.process_fingerprint(ppid)
        snapshot_state.register_client(conn, ppid, str(ppid_fp))
        self.assertEqual(snapshot_state.client_count(conn), 1)

        # No daemon row → cmd_stop's no-daemon branch runs (rc=0 with no
        # signal). The point of this test is that the deferred-path early
        # return does NOT trigger when --force is set, so the legacy code
        # path executes (which here ends up in the no-daemon branch).
        rc = daemonctl.cmd_stop(
            repo,
            git_dir,
            flush_first=False,
            session_pid=_os.getpid(),  # not in client table — irrelevant when forced
            force=True,
        )
        self.assertEqual(rc, 0)
        # Peer client row was NOT touched by --force (only the explicit
        # session_pid arg's row would be, and we deliberately picked a pid
        # that is not registered to prove --force bypasses dereg).
        self.assertEqual(snapshot_state.client_count(conn), 1)

    def test_stop_when_only_calling_session_registered_kills(self) -> None:
        """Refcount drops to 0 → take the legacy kill path."""
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        daemonctl = load_example_module(
            "snapshot_daemonctl_refcount_last", "snapshot-daemonctl.py"
        )
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        import os as _os
        own_pid = _os.getpid()
        own_fp = snapshot_state.process_fingerprint(own_pid)
        snapshot_state.register_client(conn, own_pid, str(own_fp))

        # No daemon row stamped, so cmd_stop's no-daemon branch handles
        # the actual stop semantics. The thing we're asserting is:
        #   1. The deferred-path early return does NOT trigger.
        #   2. After cmd_stop, our session row is removed (deregister ran).
        captured = StringIO()
        with mock.patch("sys.stdout", captured):
            rc = daemonctl.cmd_stop(
                repo,
                git_dir,
                flush_first=False,
                session_pid=own_pid,
            )
        self.assertEqual(rc, 0)
        import json as _json
        payload = _json.loads(captured.getvalue())
        # Last-session payload: ``deferred`` must NOT be present (or False).
        self.assertFalse(payload.get("deferred", False), payload)
        # Our row was deregistered as part of the deferred path's lock
        # block before falling through to the kill path.
        self.assertEqual(snapshot_state.client_count(conn), 0)


if __name__ == "__main__":
    unittest.main()

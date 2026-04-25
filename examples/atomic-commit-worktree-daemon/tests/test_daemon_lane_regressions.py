"""Regression tests for the daemon-lane fixes in ``snapshot-daemon.py``.

Coverage:

* ``last_capture_error`` is preserved when ``poll_once`` internally caught
  ``_IgnoreCheckFailed`` and stamped a ``"check-ignore: …"`` value — the
  daemon main loop must NOT blanket-clear that error on the same tick.
* Coalesced flush-acks are committed atomically; a crash mid-batch must
  not leave half the rows acknowledged and half pending.
* The lock-contention loser path does NOT overwrite the live peer's
  ``daemon_state`` row (pid / token / fingerprint).

The tests load the daemon module by file path because its filename
contains a hyphen, which Python's normal import machinery rejects.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock as mock
from pathlib import Path


EXAMPLE_DIR = Path(__file__).resolve().parents[1]
if str(EXAMPLE_DIR) not in sys.path:
    sys.path.insert(0, str(EXAMPLE_DIR))

import snapshot_state  # noqa: E402


def _load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, str(EXAMPLE_DIR / filename))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# Load both modules once. Registering them in sys.modules matters because the
# daemon module re-imports the capture module by file path; a fresh instance
# per test would defeat the patch we install for the _IgnoreCheckFailed test.
capture = _load_module("snapshot_capture", "snapshot-capture.py")
daemon = _load_module("snapshot_daemon", "snapshot-daemon.py")


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(
        {
            "GIT_AUTHOR_NAME": "Test User",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test User",
            "GIT_COMMITTER_EMAIL": "test@example.com",
        }
    )
    return subprocess.run(
        ["git", *args],
        cwd=str(repo),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )


def _init_repo() -> tuple[tempfile.TemporaryDirectory[str], Path, Path]:
    tmp = tempfile.TemporaryDirectory()
    repo = Path(tmp.name) / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "commit", "--allow-empty", "-m", "init")
    _, git_dir, _common = snapshot_state.resolve_repo_paths(repo)
    return tmp, repo, git_dir


class LastCaptureErrorPreservationTests(unittest.TestCase):
    """The daemon must not erase a real error stamped by poll_once."""

    def test_poll_once_internal_error_survives_capture_then_replay(self) -> None:
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        # Patch poll_once to mimic the production behavior on a broken
        # check-ignore: stamp the prefixed error into daemon_meta and return
        # cleanly (the real code path raises _IgnoreCheckFailed inside
        # poll_once, catches it, and writes the same prefixed value).
        def _poll_once_internal_error(conn_arg, repo_root, git_dir_arg):
            snapshot_state.set_daemon_meta(
                conn_arg,
                "last_capture_error",
                "check-ignore: simulated broken pattern",
            )
            return []

        original = capture.poll_once
        capture.poll_once = _poll_once_internal_error
        try:
            # Force a baseline last_capture_error so we can observe the
            # daemon's blanket-clear behavior versus the new preserve path.
            snapshot_state.set_daemon_meta(
                conn, "last_capture_error", "check-ignore: simulated broken pattern"
            )
            # _capture_then_replay must NOT erase the error to "" because the
            # value carries the poll_once-internal prefix.
            daemon._capture_then_replay(conn, repo, git_dir)
        finally:
            capture.poll_once = original

        current = snapshot_state.get_daemon_meta(conn, "last_capture_error") or ""
        self.assertTrue(
            current.startswith("check-ignore:"),
            f"expected internal-error preserved, got {current!r}",
        )
        self.assertNotEqual(current, "", "daemon erased the real error")

    def test_helper_detects_internal_error_prefix(self) -> None:
        tmp, _repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        snapshot_state.set_daemon_meta(conn, "last_capture_error", "")
        self.assertFalse(daemon._poll_once_wrote_internal_error(conn))

        snapshot_state.set_daemon_meta(
            conn, "last_capture_error", "check-ignore: bad pattern"
        )
        self.assertTrue(daemon._poll_once_wrote_internal_error(conn))

        snapshot_state.set_daemon_meta(
            conn, "last_capture_error", "some other failure mode"
        )
        # An external/unprefixed error is treated as "not poll_once-internal"
        # so the daemon main loop is free to clear it on the next clean tick.
        self.assertFalse(daemon._poll_once_wrote_internal_error(conn))


class CoalescedAckBatchAtomicityTests(unittest.TestCase):
    """All-or-nothing semantics for batched flush acks."""

    def test_partial_ack_failure_rolls_back_entire_batch(self) -> None:
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        # Queue three flush requests so the daemon's coalesce path triggers.
        ids = [
            snapshot_state.request_flush(conn, "flush", non_blocking=False)
            for _ in range(3)
        ]
        self.assertEqual(len(ids), 3)

        # Patch _ack so the second call raises. Under the old non-transactional
        # implementation rid #1 would be acked and rids #2/#3 would not — the
        # bug we are guarding against. Under the new transactional batch
        # NONE of the three should land.
        original_ack = daemon._ack
        call_count = {"n": 0}

        def _flaky_ack(conn_arg, request_id, note=""):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise RuntimeError("simulated mid-batch failure")
            original_ack(conn_arg, request_id, note)

        daemon._ack = _flaky_ack
        try:
            stop_event = threading.Event()
            with self.assertRaises(RuntimeError):
                daemon.process_requests(
                    conn,
                    repo,
                    git_dir,
                    sleeping=False,
                    stop_event=stop_event,
                )
        finally:
            daemon._ack = original_ack

        rows = conn.execute(
            "SELECT id, acknowledged_ts FROM flush_requests ORDER BY id"
        ).fetchall()
        acked = [r["id"] for r in rows if r["acknowledged_ts"] is not None]
        self.assertEqual(
            acked,
            [],
            f"expected no rows acked after rollback, got {acked!r}",
        )

    def test_successful_batch_acks_all(self) -> None:
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        for _ in range(3):
            snapshot_state.request_flush(conn, "flush", non_blocking=False)

        stop_event = threading.Event()
        daemon.process_requests(
            conn,
            repo,
            git_dir,
            sleeping=False,
            stop_event=stop_event,
        )

        rows = conn.execute(
            "SELECT id, acknowledged_ts FROM flush_requests ORDER BY id"
        ).fetchall()
        self.assertEqual(len(rows), 3)
        for row in rows:
            self.assertIsNotNone(
                row["acknowledged_ts"],
                f"row {row['id']} not acked in successful batch",
            )


class LockContentionDoesNotClobberPeerTests(unittest.TestCase):
    """The flock loser must never overwrite the live peer's daemon_state row."""

    def test_run_daemon_returns_tempfail_without_writing_state(self) -> None:
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        # Pre-populate daemon_state with a "live peer" row so we can verify
        # nothing gets overwritten by the contention path.
        peer_conn = snapshot_state.ensure_state(git_dir)
        try:
            snapshot_state.set_daemon_state(
                peer_conn,
                pid=999_999,
                mode="running",
                branch_ref="refs/heads/main",
                branch_generation=1,
                note="peer alive",
                daemon_token="peer-token",
                daemon_fingerprint="peer-fingerprint",
            )
            peer_conn.commit()
        finally:
            peer_conn.close()

        # Hold the flock from a separate file handle to simulate a live peer.
        import fcntl

        lock_path = snapshot_state.lock_path(git_dir)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        peer_fh = lock_path.open("a+")
        fcntl.flock(peer_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            rc = daemon.run_daemon(repo, git_dir)
        finally:
            try:
                fcntl.flock(peer_fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            peer_fh.close()

        self.assertEqual(rc, daemon.EX_TEMPFAIL)

        verify_conn = snapshot_state.ensure_state(git_dir)
        try:
            row = verify_conn.execute(
                "SELECT pid, mode, daemon_token, daemon_fingerprint, note "
                "FROM daemon_state WHERE id=1"
            ).fetchone()
        finally:
            verify_conn.close()

        # The peer's identity must be intact. Specifically the loser must
        # NOT have overwritten daemon_token / daemon_fingerprint / pid.
        self.assertEqual(int(row["pid"]), 999_999)
        self.assertEqual(row["mode"], "running")
        self.assertEqual(row["daemon_token"], "peer-token")
        self.assertEqual(row["daemon_fingerprint"], "peer-fingerprint")
        self.assertEqual(row["note"], "peer alive")


if __name__ == "__main__":
    unittest.main()

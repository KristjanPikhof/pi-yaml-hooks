"""Regression tests for replay-lane fixes in snapshot-replay.py.

Covers three findings:

P2 — replay_pending_events monopolized publish_lock for the entire batch.
     Fix: SNAPSHOTD_REPLAY_BATCH_MAX (default 200). The lock is released
     between batches and ``daemon_meta.last_replay_deferred`` records the
     still-queued count.

P2 — _is_ancestor could not distinguish "not an ancestor" from "object
     missing". Fix: branch on returncode (0 ancestor / 1 not / else
     raise GitObjectMissing) so daemon_meta records the real failure.

P3 — recover_publishing's published path bypassed mark_event_published
     and never set published_ts, making recovered events eligible for
     pruning the moment the next sweep ran.
"""

from __future__ import annotations

import os
import threading
import time
import unittest
from pathlib import Path

from test_worktree_daemon import (
    EXAMPLE_DIR,
    init_repo,
    load_example_module,
)

import snapshot_state  # noqa: E402  (made importable by test_worktree_daemon)


def _make_event(conn, *, ctx, blob: str, name: str) -> int:
    return snapshot_state.record_event(
        conn,
        branch_ref=ctx["branch_ref"],
        branch_generation=ctx["branch_generation"],
        base_head=ctx["base_head"],
        operation="create",
        path=name,
        old_path=None,
        fidelity="watcher",
        ops=[
            {
                "op": "create",
                "path": name,
                "before_oid": None,
                "before_mode": None,
                "after_oid": blob,
                "after_mode": "100644",
            }
        ],
    )


class ReplayLaneRegressionTests(unittest.TestCase):
    def test_batch_limit_releases_publish_lock_between_batches(self) -> None:
        """A backlog larger than batch_max must release publish_lock between batches.

        Drives a queue of three events with batch_max=1. Between the
        first and second batch, a sibling thread tries to acquire the
        publish_lock with a short timeout and must succeed — proving the
        replay loop released it. ``last_replay_deferred`` is also
        observed transitioning from a non-zero value to 0 across the
        drain.
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        replay = load_example_module(
            "snapshot_replay_batch_release", "snapshot-replay.py"
        )

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)

        # Three independent events, each touching a different file so
        # downstream verify-ops do not chain conflicts.
        for name, body in (("a.txt", "a\n"), ("b.txt", "b\n"), ("c.txt", "c\n")):
            blob = snapshot_state.capture_blob_for_text(repo, body)
            _make_event(conn, ctx=ctx, blob=blob, name=name)

        # Sibling probe: every poll attempts a non-blocking acquire of
        # the publish_lock. If we *ever* succeed while replay is mid-
        # drain, the contract holds.
        lock_path = snapshot_state.local_state_dir(git_dir) / snapshot_state.PUBLISH_LOCK_NAME
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        sibling_acquired = threading.Event()
        stop_probe = threading.Event()
        deferred_observed_nonzero = threading.Event()

        def probe() -> None:
            import fcntl
            while not stop_probe.is_set():
                try:
                    fh = open(lock_path, "a+")
                except OSError:
                    time.sleep(0.005)
                    continue
                try:
                    try:
                        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        sibling_acquired.set()
                        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                    except OSError:
                        pass
                finally:
                    fh.close()
                # Read deferred meta from a fresh connection; the replay
                # loop writes between batches, and we want to confirm
                # the count is non-zero at least once mid-drain.
                try:
                    probe_conn = snapshot_state.ensure_state(git_dir)
                    val = snapshot_state.get_daemon_meta(probe_conn, "last_replay_deferred")
                    probe_conn.close()
                    if val and val != "0":
                        deferred_observed_nonzero.set()
                except Exception:
                    pass
                time.sleep(0.005)

        probe_thread = threading.Thread(target=probe, daemon=True)
        probe_thread.start()
        try:
            total = replay.replay_pending_events(
                conn, repo, git_dir, batch_max=1
            )
        finally:
            stop_probe.set()
            probe_thread.join(timeout=2.0)

        self.assertEqual(total, 3)
        self.assertTrue(
            sibling_acquired.is_set(),
            "sibling never acquired publish_lock — replay monopolized it",
        )
        self.assertTrue(
            deferred_observed_nonzero.is_set(),
            "last_replay_deferred never went above 0 during the drain",
        )

        # After draining, deferred should be 0.
        deferred_final = snapshot_state.get_daemon_meta(conn, "last_replay_deferred")
        self.assertEqual(deferred_final, "0")

        # And all three events made it to published.
        states = [
            row["state"]
            for row in conn.execute(
                "SELECT state FROM capture_events ORDER BY seq"
            ).fetchall()
        ]
        self.assertEqual(states, ["published", "published", "published"])

    def test_object_missing_records_real_error_not_blocked_conflict(self) -> None:
        """When ``base_head`` cannot be resolved, daemon_meta must say so.

        Forces a missing-object scenario: the captured event references a
        commit OID that does not exist in the object store. The previous
        ``_is_ancestor`` returned False on any non-zero exit, so this was
        silently quarantined as "stale branch ancestry". With the fix it
        is surfaced as ``object_missing`` in ``last_replay_object_missing``
        and the event is marked ``failed`` with that exact prefix.
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        replay = load_example_module(
            "snapshot_replay_object_missing", "snapshot-replay.py"
        )

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)

        blob = snapshot_state.capture_blob_for_text(repo, "missing\n")
        seq = snapshot_state.record_event(
            conn,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            # Use a syntactically valid but unreachable OID. git
            # merge-base --is-ancestor exits 128 ("Not a valid commit
            # name") on this rather than 1.
            base_head="dead" * 10,
            operation="create",
            path="missing.txt",
            old_path=None,
            fidelity="watcher",
            ops=[
                {
                    "op": "create",
                    "path": "missing.txt",
                    "before_oid": None,
                    "before_mode": None,
                    "after_oid": blob,
                    "after_mode": "100644",
                }
            ],
        )

        published = replay.replay_pending_events(conn, repo, git_dir)
        self.assertEqual(published, 0)

        row = conn.execute(
            "SELECT state, error FROM capture_events WHERE seq=?", (seq,)
        ).fetchone()
        self.assertEqual(row["state"], "failed")
        self.assertTrue(
            row["error"] and row["error"].startswith("object_missing:"),
            f"expected object_missing prefix, got {row['error']!r}",
        )
        self.assertNotIn("stale branch ancestry", row["error"] or "")

        meta = snapshot_state.get_daemon_meta(conn, "last_replay_object_missing")
        self.assertIsNotNone(meta)
        self.assertIn(f"seq={seq}", meta)

    def test_recover_publishing_sets_published_ts(self) -> None:
        """recover_publishing must route through mark_event_published.

        Setup mirrors test_replay_recovers_publishing_event from the
        main suite — the ref has already moved to ``target`` when
        recovery runs — but the assertion here is on
        ``capture_events.published_ts``: the previous code wrote
        ``state='published'`` directly with a raw UPDATE, leaving
        published_ts NULL and exposing the row to immediate retention
        pruning. With the fix, mark_event_published sets it consistently.
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        replay = load_example_module(
            "snapshot_replay_recover_published_ts", "snapshot-replay.py"
        )

        from test_worktree_daemon import git as git_helper

        conn = snapshot_state.ensure_state(git_dir)
        ctx = snapshot_state.repo_context(repo, git_dir)
        base_head = ctx["base_head"]
        branch = ctx["branch_ref"]
        generation = ctx["branch_generation"]

        blob = snapshot_state.capture_blob_for_text(repo, "recover\n")
        seq = _make_event(conn, ctx=ctx, blob=blob, name="recover.txt")

        # Build the would-be commit out of band so the ref ends up
        # ahead of source_head with target reachable.
        env = os.environ.copy()
        env["GIT_INDEX_FILE"] = str(snapshot_state.index_path(git_dir))
        self.assertEqual(
            git_helper(repo, "read-tree", base_head, env=env).returncode, 0
        )
        snapshot_state.apply_ops_to_index(
            repo,
            env,
            [
                {
                    "op": "create",
                    "path": "recover.txt",
                    "after_oid": blob,
                    "after_mode": "100644",
                }
            ],
        )
        tree = git_helper(repo, "write-tree", env=env)
        self.assertEqual(tree.returncode, 0, tree.stderr)
        commit = git_helper(
            repo, "commit-tree", tree.stdout.strip(), "-p", base_head, env=env
        )
        self.assertEqual(commit.returncode, 0, commit.stderr)
        target = commit.stdout.strip()
        update = git_helper(repo, "update-ref", branch, target, base_head)
        self.assertEqual(update.returncode, 0, update.stderr)
        (repo / "recover.txt").write_text("recover\n", encoding="utf-8")

        snapshot_state.update_publish_state(
            conn,
            event_seq=seq,
            branch_ref=branch,
            branch_generation=generation,
            source_head=base_head,
            target_commit_oid=target,
            status="publishing",
        )
        conn.execute(
            "UPDATE capture_events SET state='publishing' WHERE seq=?", (seq,)
        )
        # Belt-and-suspenders: ensure published_ts starts NULL so the
        # post-condition truly proves recover_publishing wrote it.
        conn.execute(
            "UPDATE capture_events SET published_ts=NULL WHERE seq=?", (seq,)
        )
        conn.commit()
        conn.close()

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        before = time.time()
        replay.recover_publishing(
            conn, repo, snapshot_state.repo_context(repo, git_dir)
        )
        after = time.time()

        row = conn.execute(
            "SELECT state, commit_oid, published_ts FROM capture_events WHERE seq=?",
            (seq,),
        ).fetchone()
        self.assertEqual(row["state"], "published")
        self.assertEqual(row["commit_oid"], target)
        self.assertIsNotNone(
            row["published_ts"],
            "recover_publishing did not set published_ts; row will be eligible for "
            "retention pruning the moment the next sweep runs.",
        )
        self.assertGreaterEqual(float(row["published_ts"]), before)
        self.assertLessEqual(float(row["published_ts"]), after + 1.0)


if __name__ == "__main__":
    unittest.main()

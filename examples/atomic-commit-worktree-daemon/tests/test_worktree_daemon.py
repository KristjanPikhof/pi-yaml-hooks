from __future__ import annotations

import json
import importlib.util
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


# Default subprocess timeout for any daemonctl/replay invocation. Unbounded
# subprocess.run calls in tests are a CI hazard: a wedged daemon would hang
# the suite indefinitely. 30s is generous enough for cold cache / slow CI
# but well under the per-test sentinel.
_SUBPROC_TIMEOUT = 30.0


EXAMPLE_DIR = Path(__file__).resolve().parents[1]
if str(EXAMPLE_DIR) not in sys.path:
    sys.path.insert(0, str(EXAMPLE_DIR))

import snapshot_state  # noqa: E402


def load_example_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, str(EXAMPLE_DIR / filename))
    if spec is None or spec.loader is None:
        raise RuntimeError(filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(repo: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    proc_env = os.environ.copy()
    proc_env.update(
        {
            "GIT_AUTHOR_NAME": "Test User",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test User",
            "GIT_COMMITTER_EMAIL": "test@example.com",
            # Pin global/system config to /dev/null so a developer's local
            # .gitconfig (signing keys, conditional includes, hooks paths,
            # commit templates, signed pushes) cannot bleed into test runs
            # and cause spurious failures or, worse, false positives.
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
        }
    )
    if env:
        proc_env.update(env)
    return subprocess.run(
        ["git", *args],
        cwd=str(repo),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=proc_env,
        timeout=_SUBPROC_TIMEOUT,
    )


def init_repo() -> tuple[tempfile.TemporaryDirectory[str], Path, Path]:
    tmp = tempfile.TemporaryDirectory()
    repo = Path(tmp.name) / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "main")
    git(repo, "commit", "--allow-empty", "-m", "init")
    _, git_dir, _ = snapshot_state.resolve_repo_paths(repo)
    return tmp, repo, git_dir


class WorktreeDaemonExampleTests(unittest.TestCase):
    def test_schema_version_and_quarantine(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        conn.close()

        db = snapshot_state.db_path(git_dir)
        with sqlite3.connect(db) as db_conn:
            tables = {
                row[0]
                for row in db_conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            self.assertTrue({"daemon_state", "capture_events", "publish_state"} <= tables)
            db_conn.execute("PRAGMA user_version=99")
            db_conn.commit()

        conn = snapshot_state.ensure_state(git_dir)
        conn.close()

        quarantine_dirs = list(git_dir.glob("ai-snapshotd.incompatible-*"))
        self.assertTrue(quarantine_dirs)
        with sqlite3.connect(db) as db_conn:
            self.assertEqual(
                db_conn.execute("PRAGMA user_version").fetchone()[0],
                snapshot_state.SCHEMA_VERSION,
            )

    def test_apply_ops_supports_rename_mode_and_symlink(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        (repo / "old.txt").write_text("hello\n", encoding="utf-8")
        git(repo, "add", "old.txt")
        git(repo, "commit", "-m", "add old file")

        env = os.environ.copy()
        index = snapshot_state.index_path(git_dir)
        index.parent.mkdir(parents=True, exist_ok=True)
        env["GIT_INDEX_FILE"] = str(index)
        read_tree = git(repo, "read-tree", "HEAD", env=env)
        self.assertEqual(read_tree.returncode, 0, read_tree.stderr)

        state = snapshot_state.snapshot_state_for_index(repo, env)
        self.assertIn("old.txt", state)
        mode, oid = state["old.txt"]
        symlink_oid = snapshot_state.capture_blob_for_text(repo, "target.txt")

        snapshot_state.apply_ops_to_index(
            repo,
            env,
            [
                {
                    "op": "rename",
                    "path": "new.txt",
                    "old_path": "old.txt",
                    "before_oid": oid,
                    "before_mode": mode,
                    "after_oid": oid,
                    "after_mode": mode,
                },
                {
                    "op": "mode",
                    "path": "new.txt",
                    "before_oid": oid,
                    "before_mode": mode,
                    "after_oid": oid,
                    "after_mode": "100755",
                },
                {
                    "op": "symlink",
                    "path": "link.ln",
                    "before_oid": None,
                    "before_mode": None,
                    "after_oid": symlink_oid,
                    "after_mode": "120000",
                },
            ],
        )

        state = snapshot_state.snapshot_state_for_index(repo, env)
        self.assertNotIn("old.txt", state)
        self.assertEqual(state["new.txt"][0], "100755")
        self.assertEqual(state["link.ln"][0], "120000")

    def test_replay_commits_one_per_event(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        ctx = snapshot_state.repo_context(repo, git_dir)
        base_head = ctx["base_head"]
        branch = ctx["branch_ref"]
        generation = ctx["branch_generation"]

        one = snapshot_state.capture_blob_for_text(repo, "one\n")
        two = snapshot_state.capture_blob_for_text(repo, "two\n")

        snapshot_state.record_event(
            conn,
            branch_ref=branch,
            branch_generation=generation,
            base_head=base_head,
            operation="create",
            path="alpha.txt",
            old_path=None,
            fidelity="watcher",
            ops=[
                {
                    "op": "create",
                    "path": "alpha.txt",
                    "before_oid": None,
                    "before_mode": None,
                    "after_oid": one,
                    "after_mode": "100644",
                }
            ],
        )
        snapshot_state.record_event(
            conn,
            branch_ref=branch,
            branch_generation=generation,
            base_head=base_head,
            operation="modify",
            path="alpha.txt",
            old_path=None,
            fidelity="watcher",
            ops=[
                {
                    "op": "modify",
                    "path": "alpha.txt",
                    "before_oid": one,
                    "before_mode": "100644",
                    "after_oid": two,
                    "after_mode": "100644",
                }
            ],
        )
        snapshot_state.record_event(
            conn,
            branch_ref=branch,
            branch_generation=generation,
            base_head=base_head,
            operation="delete",
            path="alpha.txt",
            old_path=None,
            fidelity="watcher",
            ops=[
                {
                    "op": "delete",
                    "path": "alpha.txt",
                    "before_oid": two,
                    "before_mode": "100644",
                    "after_oid": None,
                    "after_mode": None,
                }
            ],
        )
        conn.close()

        proc = subprocess.run(
            [sys.executable, str(EXAMPLE_DIR / "snapshot-replay.py"), "--flush", "--repo", str(repo)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("published=3", proc.stdout)

        rev_count = git(repo, "rev-list", "--count", "HEAD")
        self.assertEqual(rev_count.returncode, 0, rev_count.stderr)
        self.assertEqual(rev_count.stdout.strip(), "4")

    def test_replay_recovers_publishing_event(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        ctx = snapshot_state.repo_context(repo, git_dir)
        base_head = ctx["base_head"]
        branch = ctx["branch_ref"]
        generation = ctx["branch_generation"]
        blob = snapshot_state.capture_blob_for_text(repo, "recover\n")
        seq = snapshot_state.record_event(
            conn,
            branch_ref=branch,
            branch_generation=generation,
            base_head=base_head,
            operation="create",
            path="recover.txt",
            old_path=None,
            fidelity="watcher",
            ops=[
                {
                    "op": "create",
                    "path": "recover.txt",
                    "before_oid": None,
                    "before_mode": None,
                    "after_oid": blob,
                    "after_mode": "100644",
                }
            ],
        )

        env = os.environ.copy()
        env["GIT_INDEX_FILE"] = str(snapshot_state.index_path(git_dir))
        self.assertEqual(git(repo, "read-tree", base_head, env=env).returncode, 0)
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
        tree = git(repo, "write-tree", env=env)
        self.assertEqual(tree.returncode, 0, tree.stderr)
        commit = git(repo, "commit-tree", tree.stdout.strip(), "-p", base_head, env=env)
        self.assertEqual(commit.returncode, 0, commit.stderr)
        target = commit.stdout.strip()
        update = git(repo, "update-ref", branch, target, base_head)
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
        conn.execute("UPDATE capture_events SET state='publishing' WHERE seq=?", (seq,))
        conn.close()

        proc = subprocess.run(
            [sys.executable, str(EXAMPLE_DIR / "snapshot-replay.py"), "--flush", "--repo", str(repo)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("published=0", proc.stdout)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        row = conn.execute("SELECT state, commit_oid FROM capture_events WHERE seq=?", (seq,)).fetchone()
        self.assertEqual(row["state"], "published")
        self.assertEqual(row["commit_oid"], target)
        status = git(repo, "status", "--porcelain", "--", "recover.txt")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual(status.stdout.strip(), "")

    def test_polling_create_modify_delete_sequence(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        capture = load_example_module("snapshot_capture_test", "snapshot-capture.py")
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)
        capture.bootstrap_shadow(
            conn,
            repo,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            base_head=ctx["base_head"],
        )

        alpha = repo / "alpha.txt"
        alpha.write_text("one\n", encoding="utf-8")
        self.assertEqual(capture.poll_once(conn, repo, git_dir), [1])

        alpha.write_text("two\n", encoding="utf-8")
        self.assertEqual(capture.poll_once(conn, repo, git_dir), [2])

        alpha.unlink()
        self.assertEqual(capture.poll_once(conn, repo, git_dir), [3])

        rows = conn.execute(
            "SELECT operation, path, fidelity FROM capture_events ORDER BY seq"
        ).fetchall()
        self.assertEqual([row["operation"] for row in rows], ["create", "modify", "delete"])
        self.assertTrue(all(row["fidelity"] == "rescan" for row in rows))

    def test_polling_skips_ignored_and_sensitive_files(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        capture = load_example_module("snapshot_capture_exclusion_test", "snapshot-capture.py")
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)
        capture.bootstrap_shadow(
            conn,
            repo,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            base_head=ctx["base_head"],
        )

        (repo / ".gitignore").write_text("*.log\n", encoding="utf-8")
        (repo / "ignored.log").write_text("ignored\n", encoding="utf-8")
        (repo / ".env").write_text("SECRET=1\n", encoding="utf-8")
        seqs = capture.poll_once(conn, repo, git_dir)
        rows = conn.execute("SELECT path FROM capture_events ORDER BY seq").fetchall()
        self.assertEqual(seqs, [1])
        self.assertEqual([row["path"] for row in rows], [".gitignore"])

    def test_replay_reconciles_live_index_after_publish(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)
        blob = snapshot_state.capture_blob_for_text(repo, "clean\n")
        (repo / "clean.txt").write_text("clean\n", encoding="utf-8")
        snapshot_state.record_event(
            conn,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            base_head=ctx["base_head"],
            operation="create",
            path="clean.txt",
            old_path=None,
            fidelity="watcher",
            ops=[
                {
                    "op": "create",
                    "path": "clean.txt",
                    "before_oid": None,
                    "before_mode": None,
                    "after_oid": blob,
                    "after_mode": "100644",
                }
            ],
        )
        replay = load_example_module("snapshot_replay_reconcile_test", "snapshot-replay.py")
        self.assertEqual(replay.replay_pending_events(conn, repo, git_dir), 1)
        status = git(repo, "status", "--porcelain", "--", "clean.txt")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual(status.stdout.strip(), "")

    def test_replay_stops_after_update_ref_failure(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)
        first = snapshot_state.capture_blob_for_text(repo, "first\n")
        second = snapshot_state.capture_blob_for_text(repo, "second\n")
        for name, blob in (("first.txt", first), ("second.txt", second)):
            snapshot_state.record_event(
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

        replay = load_example_module("snapshot_replay_failure_test", "snapshot-replay.py")
        original_run = replay.subprocess.run

        def fail_update_ref(args, *pargs, **kwargs):
            if len(args) > 1 and args[1] == "update-ref":
                return subprocess.CompletedProcess(args, 1, stdout=b"", stderr=b"forced failure")
            return original_run(args, *pargs, **kwargs)

        replay.subprocess.run = fail_update_ref
        try:
            self.assertEqual(replay.replay_pending_events(conn, repo, git_dir), 0)
        finally:
            replay.subprocess.run = original_run
        states = [
            row["state"]
            for row in conn.execute("SELECT state FROM capture_events ORDER BY seq").fetchall()
        ]
        self.assertEqual(states, ["blocked_conflict", "pending"])

    def test_replay_stops_after_commit_build_failure(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)
        first = snapshot_state.capture_blob_for_text(repo, "first\n")
        second = snapshot_state.capture_blob_for_text(repo, "second\n")
        for name, blob in (("first.txt", first), ("second.txt", second)):
            snapshot_state.record_event(
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

        replay = load_example_module("snapshot_replay_build_failure_test", "snapshot-replay.py")
        original_run = replay.subprocess.run

        def fail_write_tree(args, *pargs, **kwargs):
            if len(args) > 1 and args[1] == "write-tree":
                return subprocess.CompletedProcess(args, 1, stdout=b"", stderr=b"forced write-tree failure")
            return original_run(args, *pargs, **kwargs)

        replay.subprocess.run = fail_write_tree
        try:
            self.assertEqual(replay.replay_pending_events(conn, repo, git_dir), 0)
        finally:
            replay.subprocess.run = original_run
        states = [
            row["state"]
            for row in conn.execute("SELECT state FROM capture_events ORDER BY seq").fetchall()
        ]
        self.assertEqual(states, ["failed", "pending"])

    def test_replay_stops_after_commit_tree_failure(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)
        first = snapshot_state.capture_blob_for_text(repo, "first\n")
        second = snapshot_state.capture_blob_for_text(repo, "second\n")
        for name, blob in (("first.txt", first), ("second.txt", second)):
            snapshot_state.record_event(
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

        replay = load_example_module("snapshot_replay_commit_tree_failure_test", "snapshot-replay.py")
        original_run = replay.subprocess.run

        def fail_commit_tree(args, *pargs, **kwargs):
            if len(args) > 1 and args[1] == "commit-tree":
                return subprocess.CompletedProcess(args, 1, stdout=b"", stderr=b"forced commit-tree failure")
            return original_run(args, *pargs, **kwargs)

        replay.subprocess.run = fail_commit_tree
        try:
            self.assertEqual(replay.replay_pending_events(conn, repo, git_dir), 0)
        finally:
            replay.subprocess.run = original_run
        states = [
            row["state"]
            for row in conn.execute("SELECT state FROM capture_events ORDER BY seq").fetchall()
        ]
        self.assertEqual(states, ["failed", "pending"])

    def test_daemon_processes_flush_sleep_and_stop_requests(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        daemon = load_example_module("snapshot_daemon_test", "snapshot-daemon.py")
        capture = load_example_module("snapshot_capture_daemon_test", "snapshot-capture.py")
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)
        capture.bootstrap_shadow(
            conn,
            repo,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            base_head=ctx["base_head"],
        )
        (repo / "queued.txt").write_text("queued\n", encoding="utf-8")
        snapshot_state.request_flush(conn, "wake", True, note="wake")
        snapshot_state.request_flush(conn, "flush", False, note="flush")
        snapshot_state.request_flush(conn, "sleep", False, note="sleep")
        snapshot_state.request_flush(conn, "stop", False, note="stop")

        replay_calls: list[tuple[Path, Path]] = []

        def _stub_replay(_conn, repo_root, git_dir):
            replay_calls.append((repo_root, git_dir))
            return 1

        # patch.object restores the original attribute even on assertion
        # failure (the bare setattr/finally form leaked when the test body
        # raised before reaching ``finally`` at module-import time).
        with mock.patch.object(daemon, "_replay_pending", _stub_replay):
            sleeping = daemon.process_requests(
                conn,
                repo,
                git_dir,
                sleeping=True,
                stop_event=threading.Event(),
            )

        self.assertTrue(sleeping)
        self.assertEqual(len(replay_calls), 2)
        self.assertTrue(
            all(
                row[0]
                for row in conn.execute(
                    "SELECT acknowledged_ts FROM flush_requests ORDER BY id"
                ).fetchall()
            )
        )

    def test_controller_commands_are_idempotent_and_degrade_cleanly(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        script = EXAMPLE_DIR / "snapshot-daemonctl.py"

        start1 = subprocess.run(
            [sys.executable, str(script), "start", "--repo", str(repo)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(start1.returncode, 0, start1.stderr)

        start2 = subprocess.run(
            [sys.executable, str(script), "start", "--repo", str(repo)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(start2.returncode, 0, start2.stderr)

        flush = subprocess.run(
            [sys.executable, str(script), "flush", "--repo", str(repo), "--non-blocking"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(flush.returncode, 0, flush.stderr)

        status = subprocess.run(
            [sys.executable, str(script), "status", "--repo", str(repo)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(status.returncode, 0, status.stderr)
        payload = json.loads(status.stdout)
        self.assertTrue(payload["daemon_script_present"])
        self.assertGreaterEqual(payload["flush_requests"], 1)

        stop = subprocess.run(
            [sys.executable, str(script), "stop", "--repo", str(repo)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(stop.returncode, 0, stop.stderr)

        status_after_stop = subprocess.run(
            [sys.executable, str(script), "status", "--repo", str(repo)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(status_after_stop.returncode, 0, status_after_stop.stderr)
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        unacked = conn.execute(
            "SELECT COUNT(*) FROM flush_requests WHERE acknowledged_ts IS NULL"
        ).fetchone()[0]
        self.assertEqual(unacked, 0)


    def test_hostile_git_env_does_not_redirect_daemon_operations(self) -> None:
        """A poisoned GIT_DIR/GIT_OBJECT_DIRECTORY must not redirect blob writes.

        Regression for P0-2: if the parent environment sets GIT_DIR to an
        attacker-controlled path, _clean_git_env() must strip it before each
        git subprocess so blobs still land in the real repo's object DB.
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        evil_dir = Path(tmp.name) / "evil"
        evil_dir.mkdir()

        # mock.patch.dict guarantees the prior environment is restored even
        # if the assertion explodes mid-test — manual save/restore around a
        # try/finally has bitten us with "test failed but worker env is
        # poisoned for every subsequent test" before.
        with mock.patch.dict(
            os.environ,
            {
                "GIT_DIR": str(evil_dir),
                "GIT_OBJECT_DIRECTORY": str(evil_dir / "objects"),
            },
        ):
            oid = snapshot_state.capture_blob_for_text(repo, "sentinel payload\n")

        self.assertEqual(len(oid), 40)
        # Blob must be readable from the real repo, not the evil dir.
        check = git(repo, "cat-file", "-e", oid)
        self.assertEqual(check.returncode, 0, check.stderr)
        # Evil dir must not contain the written object.
        self.assertFalse((evil_dir / "objects").exists() and any((evil_dir / "objects").iterdir()))


    def test_replay_rolls_back_when_ref_unchanged(self) -> None:
        """recover_publishing must rewind a 'publishing' event whose ref never moved.

        Setup mirrors test_replay_recovers_publishing_event but skips the
        update-ref call, so live_head still equals source_head when recovery
        runs. The event should go back to 'pending' and publish_state should
        be cleared (status='idle').
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        ctx = snapshot_state.repo_context(repo, git_dir)
        base_head = ctx["base_head"]
        branch = ctx["branch_ref"]
        generation = ctx["branch_generation"]
        blob = snapshot_state.capture_blob_for_text(repo, "rollback\n")
        seq = snapshot_state.record_event(
            conn,
            branch_ref=branch,
            branch_generation=generation,
            base_head=base_head,
            operation="create",
            path="rollback.txt",
            old_path=None,
            fidelity="watcher",
            ops=[
                {
                    "op": "create",
                    "path": "rollback.txt",
                    "before_oid": None,
                    "before_mode": None,
                    "after_oid": blob,
                    "after_mode": "100644",
                }
            ],
        )
        # Manufacture a publishing record without any actual ref move.
        snapshot_state.update_publish_state(
            conn,
            event_seq=seq,
            branch_ref=branch,
            branch_generation=generation,
            source_head=base_head,
            target_commit_oid="0" * 40,
            status="publishing",
        )
        conn.execute("UPDATE capture_events SET state='publishing' WHERE seq=?", (seq,))
        conn.commit()
        conn.close()

        replay = load_example_module("snapshot_replay_rollback", "snapshot-replay.py")
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        replay.recover_publishing(conn, repo, ctx)
        conn.commit()

        row = conn.execute(
            "SELECT state, error FROM capture_events WHERE seq=?",
            (seq,),
        ).fetchone()
        self.assertEqual(row["state"], "pending")
        publish = conn.execute("SELECT status, event_seq FROM publish_state WHERE id=1").fetchone()
        self.assertEqual(publish["status"], "idle")
        self.assertIsNone(publish["event_seq"])

    def test_signal_driven_wake(self) -> None:
        """SIGUSR1 to a running daemon must trigger an immediate poll cycle."""
        import signal as _signal
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        # Slow the poll loop down so the post-signal poll is observable but
        # the natural ticks won't satisfy the assertion on their own.
        env = os.environ.copy()
        env["SNAPSHOTD_POLL_INTERVAL"] = "5.0"
        env["SNAPSHOTD_SLEEP_INTERVAL"] = "5.0"

        proc = subprocess.Popen(
            [sys.executable, str(EXAMPLE_DIR / "snapshot-daemon.py"), "--repo", str(repo)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        try:
            # Wait for daemon to advertise running mode.
            deadline = time.time() + 10.0
            conn = snapshot_state.ensure_state(git_dir)
            self.addCleanup(conn.close)
            while time.time() < deadline:
                row = conn.execute(
                    "SELECT pid, mode FROM daemon_state WHERE id=1"
                ).fetchone()
                if row and row["mode"] in {"running", "bootstrapping"} and int(row["pid"] or 0) == proc.pid:
                    break
                time.sleep(0.05)
            else:
                self.fail("daemon never reported running")

            # Let the bootstrap-driven first poll settle before timing the wake.
            time.sleep(0.5)
            initial_count = int(
                conn.execute("SELECT COUNT(*) FROM capture_events").fetchone()[0]
            )
            (repo / "wake-target.txt").write_text("wake\n", encoding="utf-8")
            # POLL_INTERVAL=5 means the natural next poll is ~5s away. The
            # signal must short-circuit the sleep loop and produce an event
            # well before that.
            os.kill(proc.pid, _signal.SIGUSR1)

            deadline = time.time() + 3.0
            saw_event = False
            while time.time() < deadline:
                count = int(
                    conn.execute("SELECT COUNT(*) FROM capture_events").fetchone()[0]
                )
                if count > initial_count:
                    saw_event = True
                    break
                time.sleep(0.05)
            self.assertTrue(saw_event, "SIGUSR1 did not produce a poll within 3s")
        finally:
            try:
                os.kill(proc.pid, _signal.SIGTERM)
            except OSError:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)

    def test_pid_reuse_rejected_via_identity_token(self) -> None:
        """A daemon row whose token doesn't match must not receive signals.

        Models PID reuse: the recorded daemon exited and an unrelated process
        (here a sleep child we spawn) was assigned the same pid. The token
        recorded in daemon_state belongs to the dead daemon, so _signal_daemon
        must refuse to deliver SIGUSR1 to the sleep process.
        """
        import signal as _signal
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        sleep_proc = subprocess.Popen(
            ["/bin/sleep", "30"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(lambda: (sleep_proc.terminate(), sleep_proc.wait(timeout=5)))

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        # Stamp a stale daemon row pointing at the sleep pid with a fake token.
        snapshot_state.set_daemon_state(
            conn,
            pid=sleep_proc.pid,
            mode="running",
            note="synthesized stale row",
            daemon_token="not-a-real-token",
        )
        conn.commit()

        daemonctl = load_example_module("snapshot_daemonctl_pidreuse", "snapshot-daemonctl.py")
        # Controller-cached token differs from the row's token.
        sent = daemonctl._signal_daemon(conn, _signal.SIGUSR1, expected_token="real-token")
        self.assertFalse(sent, "controller signaled a process with mismatched token")

        # Even without an expected token, an unverified row should not signal.
        snapshot_state.set_daemon_state(
            conn,
            pid=sleep_proc.pid,
            mode="running",
            note="cleared token",
            daemon_token=None,
        )
        conn.commit()
        sent2 = daemonctl._signal_daemon(conn, _signal.SIGUSR1)
        self.assertFalse(sent2, "controller signaled a process with no token recorded")

    def test_branch_swap_during_session(self) -> None:
        """A branch swap must not leak the prior branch's edits into the new branch.

        Bootstrap on main with file.txt committed, modify it, then check out a
        new branch, modify a different file, and run poll_once. Capture events
        recorded under branch B must reference branch B and must not include
        a phantom delete/create pair carrying file.txt's edit from branch A.
        """
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        # Commit a baseline file on main.
        (repo / "file.txt").write_text("base\n", encoding="utf-8")
        git(repo, "add", "file.txt")
        git(repo, "commit", "-m", "add file")

        capture = load_example_module("snapshot_capture_branchswap", "snapshot-capture.py")
        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        # Bootstrap shadow on main.
        ctx_a = snapshot_state.repo_context(repo, git_dir)
        capture.bootstrap_shadow(
            conn,
            repo,
            branch_ref=ctx_a["branch_ref"],
            branch_generation=ctx_a["branch_generation"],
            base_head=ctx_a["base_head"],
        )

        # Modify file.txt — would become a 'modify' event under main.
        (repo / "file.txt").write_text("dirty on main\n", encoding="utf-8")

        # Check out a new branch B without committing the dirty edit.
        co = git(repo, "checkout", "-b", "feature")
        self.assertEqual(co.returncode, 0, co.stderr)
        # Reset the dirty file to HEAD so the branch swap leaves a clean tree.
        git(repo, "checkout", "--", "file.txt")

        # Touch a different file under branch B.
        (repo / "other.txt").write_text("only on feature\n", encoding="utf-8")

        seqs = capture.poll_once(conn, repo, git_dir)
        rows = conn.execute(
            "SELECT branch_ref, operation, path FROM capture_events WHERE seq IN (%s)"
            % ",".join(["?"] * len(seqs)) if seqs else "SELECT branch_ref, operation, path FROM capture_events WHERE 0",
            seqs if seqs else [],
        ).fetchall()
        # Every event recorded by this poll must belong to branch B.
        self.assertTrue(rows, "expected at least one event under feature branch")
        for row in rows:
            self.assertEqual(row["branch_ref"], "refs/heads/feature")
            # No phantom delete/create on file.txt (the baseline file).
            if row["path"] == "file.txt":
                self.fail(
                    f"phantom event for file.txt leaked from main: {dict(row)}"
                )


if __name__ == "__main__":
    unittest.main()

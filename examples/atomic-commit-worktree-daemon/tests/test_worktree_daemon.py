from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


EXAMPLE_DIR = Path(__file__).resolve().parents[1]
if str(EXAMPLE_DIR) not in sys.path:
    sys.path.insert(0, str(EXAMPLE_DIR))

import snapshot_state  # noqa: E402


def git(repo: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    proc_env = os.environ.copy()
    proc_env.update(
        {
            "GIT_AUTHOR_NAME": "Test User",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test User",
            "GIT_COMMITTER_EMAIL": "test@example.com",
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

        quarantine_dirs = list(git_dir.parent.glob("ai-snapshotd.incompatible-*"))
        self.assertTrue(quarantine_dirs)
        with sqlite3.connect(db) as db_conn:
            self.assertEqual(db_conn.execute("PRAGMA user_version").fetchone()[0], 1)

    def test_apply_ops_supports_rename_mode_and_symlink(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        (repo / "old.txt").write_text("hello\n", encoding="utf-8")
        git(repo, "add", "old.txt")
        git(repo, "commit", "-m", "add old file")

        env = os.environ.copy()
        index = snapshot_state.index_path(git_dir)
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
        self.assertFalse(payload["daemon_script_present"])
        self.assertGreaterEqual(payload["flush_requests"], 1)

        stop = subprocess.run(
            [sys.executable, str(script), "stop", "--repo", str(repo), "--flush"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(stop.returncode, 0, stop.stderr)


if __name__ == "__main__":
    unittest.main()

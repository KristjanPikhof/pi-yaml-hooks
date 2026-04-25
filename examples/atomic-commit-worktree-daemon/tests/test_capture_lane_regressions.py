"""Regression tests for capture-lane fixes in ``snapshot-capture.py``.

Each test pins one of the four findings from the capture-lane review:

1. Bootstrap failure must not wipe shadow + stamp the marker (P1).
2. Files larger than ``SNAPSHOTD_MAX_FILE_BYTES`` must be skipped, not OOM
   the daemon (P1).
3. Symlink target validation must not be vulnerable to a TOCTOU flip
   between validate-readlink and store-readlink (P2).
4. ``_STAT_CACHE`` must hold at most one entry per repo (P2).

The tests reuse helpers from the existing ``test_worktree_daemon`` module by
import — that module is owned by another lane and we deliberately avoid
modifying it. If the existing helpers move, this file degrades to the small
local fixture defined at the top.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


EXAMPLE_DIR = Path(__file__).resolve().parents[1]
if str(EXAMPLE_DIR) not in sys.path:
    sys.path.insert(0, str(EXAMPLE_DIR))

import snapshot_state  # noqa: E402


def _load_capture_module():
    """Load ``snapshot-capture.py`` (hyphen makes it non-importable directly)."""
    spec = importlib.util.spec_from_file_location(
        "snapshot_capture_regressions", str(EXAMPLE_DIR / "snapshot-capture.py")
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load snapshot-capture.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
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


def _init_repo() -> tuple[tempfile.TemporaryDirectory, Path, Path]:
    tmp = tempfile.TemporaryDirectory()
    repo = Path(tmp.name) / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "commit", "--allow-empty", "-m", "init")
    _, git_dir, _common = snapshot_state.resolve_repo_paths(repo)
    return tmp, repo, git_dir


class BootstrapLsTreeFailureTests(unittest.TestCase):
    """Finding 1 (P1): a failing ``git ls-tree`` must NOT wipe shadow or marker."""

    def test_ls_tree_failure_leaves_shadow_and_marker_untouched(self) -> None:
        capture = _load_capture_module()
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        # Seed a tracked file so the shadow has something real to lose.
        (repo / "alpha.txt").write_text("hello\n", encoding="utf-8")
        _git(repo, "add", "alpha.txt")
        _git(repo, "commit", "-m", "add alpha")

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)
        ctx = snapshot_state.repo_context(repo, git_dir)

        # First successful bootstrap establishes the baseline + marker.
        capture.bootstrap_shadow(
            conn,
            repo,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
            base_head=ctx["base_head"],
        )
        marker_key = capture._bootstrap_meta_key(
            ctx["branch_ref"], ctx["branch_generation"]
        )
        before_marker = snapshot_state.get_daemon_meta(conn, marker_key)
        before_shadow = snapshot_state.load_shadow_paths(
            conn,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
        )
        self.assertEqual(before_marker, ctx["base_head"])
        self.assertIn("alpha.txt", before_shadow)

        # Now simulate ls-tree failure by patching subprocess.run inside the
        # capture module to return a non-zero exit. We force a fresh
        # bootstrap by clearing the marker so the function actually executes
        # the read.
        snapshot_state.set_daemon_meta(conn, marker_key, "")
        original_run = capture.subprocess.run

        class _Fail:
            returncode = 128
            stdout = b""
            stderr = b"fatal: bad object HEAD\n"

        def _fake_run(cmd, *args, **kwargs):
            if isinstance(cmd, list) and len(cmd) >= 2 and cmd[1] == "ls-tree":
                return _Fail()
            return original_run(cmd, *args, **kwargs)

        capture.subprocess.run = _fake_run
        try:
            with self.assertRaises(capture._HeadTreeReadFailed):
                capture.bootstrap_shadow(
                    conn,
                    repo,
                    branch_ref=ctx["branch_ref"],
                    branch_generation=ctx["branch_generation"],
                    base_head=ctx["base_head"],
                )
        finally:
            capture.subprocess.run = original_run

        # Shadow must still hold the original entries; marker must NOT be
        # restamped (we cleared it above; if the bug regressed, the failed
        # path would have restamped it to base_head).
        after_shadow = snapshot_state.load_shadow_paths(
            conn,
            branch_ref=ctx["branch_ref"],
            branch_generation=ctx["branch_generation"],
        )
        after_marker = snapshot_state.get_daemon_meta(conn, marker_key)
        self.assertEqual(after_shadow.keys(), before_shadow.keys())
        self.assertNotEqual(after_marker, ctx["base_head"])
        # And the failure was recorded for operators.
        last_err = snapshot_state.get_daemon_meta(conn, "last_bootstrap_error")
        self.assertTrue(last_err)

    def test_poll_once_swallows_head_failure_and_emits_no_events(self) -> None:
        """``poll_once`` should bail cleanly when bootstrap can't read HEAD."""
        capture = _load_capture_module()
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        conn = snapshot_state.ensure_state(git_dir)
        self.addCleanup(conn.close)

        # Force a fresh bootstrap path by ensuring no prior marker exists,
        # then make ls-tree fail.
        original_run = capture.subprocess.run

        class _Fail:
            returncode = 128
            stdout = b""
            stderr = b"fatal: corrupt loose object\n"

        def _fake_run(cmd, *args, **kwargs):
            if isinstance(cmd, list) and len(cmd) >= 2 and cmd[1] == "ls-tree":
                return _Fail()
            return original_run(cmd, *args, **kwargs)

        capture.subprocess.run = _fake_run
        try:
            seqs = capture.poll_once(conn, repo, git_dir)
        finally:
            capture.subprocess.run = original_run

        self.assertEqual(seqs, [])
        self.assertTrue(
            snapshot_state.get_daemon_meta(conn, "last_capture_error")
        )


class LargeFileCapTests(unittest.TestCase):
    """Finding 2 (P1): files larger than the cap must be skipped + recorded."""

    def test_oversized_file_skipped_with_daemon_meta_note(self) -> None:
        capture = _load_capture_module()
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

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

        # Cap to 1KiB so the test stays quick; the file just needs to exceed
        # the configured ceiling, which the env-var override controls.
        os.environ["SNAPSHOTD_MAX_FILE_BYTES"] = "1024"
        self.addCleanup(os.environ.pop, "SNAPSHOTD_MAX_FILE_BYTES", None)

        big = repo / "big.bin"
        big.write_bytes(b"x" * (4 * 1024))  # 4 KiB > 1 KiB cap
        small = repo / "small.txt"
        small.write_text("ok\n", encoding="utf-8")

        seqs = capture.poll_once(conn, repo, git_dir)

        # The small file must still produce an event; the big file must not.
        rows = conn.execute(
            "SELECT path FROM capture_events ORDER BY seq"
        ).fetchall()
        captured_paths = [row["path"] for row in rows]
        self.assertIn("small.txt", captured_paths)
        self.assertNotIn("big.bin", captured_paths)
        self.assertEqual(len(seqs), len(captured_paths))

        # Skip is recorded in daemon_meta for operator visibility.
        skip_note = snapshot_state.get_daemon_meta(
            conn, "capture-skip-large:big.bin"
        )
        self.assertTrue(skip_note)
        self.assertIn("size=", skip_note)
        self.assertIn("cap=1024", skip_note)


class SymlinkToctouTests(unittest.TestCase):
    """Finding 3 (P2): the validated bytes must equal the stored bytes."""

    def test_validated_target_bytes_match_stored_bytes(self) -> None:
        capture = _load_capture_module()
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        link = repo / "link"
        target_inside = repo / "inside.txt"
        target_inside.write_text("safe\n", encoding="utf-8")
        os.symlink("inside.txt", link)

        readlink_calls: list[str] = []
        original_readlink = os.readlink

        def _flipping_readlink(path, *args, **kwargs):
            spath = os.fspath(path)
            readlink_calls.append(spath)
            if spath.endswith("link") and len(readlink_calls) > 1:
                # Second call (the bug) would observe a different target.
                # If our fix is in place, this branch is never reached.
                return "/etc/passwd"
            return original_readlink(path, *args, **kwargs)

        os.readlink = _flipping_readlink
        try:
            data = capture._validated_symlink_target_bytes(link, repo)
        finally:
            os.readlink = original_readlink

        # Single readlink — the very point of the fix.
        self.assertEqual(
            len([c for c in readlink_calls if c.endswith("link")]),
            1,
            f"expected exactly one readlink for the symlink, got {readlink_calls}",
        )
        # And the bytes returned for storage are the bytes that passed
        # validation (the in-repo target), not the would-be malicious flip.
        self.assertEqual(data, b"inside.txt")

    def test_unsafe_target_returns_none(self) -> None:
        """Sanity check: the merged helper still rejects escaping targets."""
        capture = _load_capture_module()
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        link = repo / "escape"
        os.symlink("/etc/hosts", link)
        self.assertIsNone(capture._validated_symlink_target_bytes(link, repo))


class StatCacheEvictionTests(unittest.TestCase):
    """Finding 4 (P2): _STAT_CACHE keeps at most one entry per repo."""

    def test_generation_bump_evicts_prior_entry(self) -> None:
        capture = _load_capture_module()
        tmp, repo, git_dir = _init_repo()
        self.addCleanup(tmp.cleanup)

        # Pre-seed the cache with a stale (branch, generation) entry for this
        # repo, mimicking what would be left over after a branch swap.
        stale_key = capture._cache_key(repo, "refs/heads/old", 7)
        capture._STAT_CACHE[stale_key] = {"alpha.txt": (1, 2, "deadbeef")}

        # Touch any file so the scan has something to do.
        (repo / "alpha.txt").write_text("a\n", encoding="utf-8")

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
        capture.poll_once(conn, repo, git_dir)

        active_key = capture._cache_key(
            repo, ctx["branch_ref"], ctx["branch_generation"]
        )
        repo_keys = [k for k in capture._STAT_CACHE.keys() if k[0] == str(repo)]
        # Exactly one entry for this repo, and it's the active one.
        self.assertEqual(len(repo_keys), 1, repo_keys)
        self.assertEqual(repo_keys[0], active_key)
        self.assertNotIn(stale_key, capture._STAT_CACHE)

    def test_unrelated_repo_entries_are_preserved(self) -> None:
        """Eviction is per-repo: another repo's cache entry must stay."""
        capture = _load_capture_module()
        tmp_a, repo_a, git_dir_a = _init_repo()
        self.addCleanup(tmp_a.cleanup)
        tmp_b, repo_b, git_dir_b = _init_repo()
        self.addCleanup(tmp_b.cleanup)

        # Seed an entry for repo_b that must survive a scan on repo_a.
        b_key = capture._cache_key(repo_b, "refs/heads/main", 1)
        capture._STAT_CACHE[b_key] = {"x": (0, 0, "abcd")}

        (repo_a / "f.txt").write_text("hi\n", encoding="utf-8")
        conn_a = snapshot_state.ensure_state(git_dir_a)
        self.addCleanup(conn_a.close)
        ctx_a = snapshot_state.repo_context(repo_a, git_dir_a)
        capture.bootstrap_shadow(
            conn_a,
            repo_a,
            branch_ref=ctx_a["branch_ref"],
            branch_generation=ctx_a["branch_generation"],
            base_head=ctx_a["base_head"],
        )
        capture.poll_once(conn_a, repo_a, git_dir_a)

        self.assertIn(b_key, capture._STAT_CACHE)


if __name__ == "__main__":
    unittest.main()

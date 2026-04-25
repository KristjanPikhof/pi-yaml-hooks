"""Regression tests for the state-lane and shared-lane fixes.

Covers:
* P1 (state) Empty ``SNAPSHOTD_SENSITIVE_GLOBS`` falls back to defaults.
* P2 (state) ``process_fingerprint`` prefers /proc on Linux, ps on darwin.
* P2 (state) ``is_sensitive_path`` handles top-level matches for ``**/X`` globs.
* P1 (shared) PATH-hijack: bare ``git`` in PATH must not redirect daemon git.
* P1 (shared) Fast-forward commits do not bump the branch generation.

The tests reuse the helpers from ``test_worktree_daemon`` where they exist
(``init_repo`` / ``git``) so behavior stays aligned with the rest of the
suite.
"""

from __future__ import annotations

import os
import stat
import sys
import unittest
from pathlib import Path
from unittest import mock

# Make the example dir importable, mirroring test_worktree_daemon.
EXAMPLE_DIR = Path(__file__).resolve().parents[1]
if str(EXAMPLE_DIR) not in sys.path:
    sys.path.insert(0, str(EXAMPLE_DIR))

import snapshot_shared  # noqa: E402
import snapshot_state  # noqa: E402

from test_worktree_daemon import git, init_repo  # noqa: E402


class SensitiveGlobRegressionTests(unittest.TestCase):
    """State-lane P1 + P2 — sensitive-path filtering correctness."""

    def test_empty_override_falls_back_to_defaults(self) -> None:
        # An empty/whitespace-only env var must not silently disable filtering.
        for value in ("", "   ", "\t,  , "):
            with mock.patch.dict(os.environ, {"SNAPSHOTD_SENSITIVE_GLOBS": value}):
                patterns = snapshot_state._sensitive_patterns()
                self.assertTrue(patterns, f"empty override {value!r} produced no patterns")
                # Both top-level "secrets/foo" and bare "credentials.json" must
                # match — if defaults stay active the **/-expansion handles them.
                self.assertTrue(snapshot_state.is_sensitive_path("secrets/foo"))
                self.assertTrue(snapshot_state.is_sensitive_path("credentials.json"))
                self.assertTrue(snapshot_state.is_sensitive_path("a/b/.env"))
                self.assertTrue(snapshot_state.is_sensitive_path(".env"))

    def test_top_level_glob_matches_for_double_star_patterns(self) -> None:
        # Without the ``**/X`` -> ``X`` expansion fnmatch would miss bare
        # top-level secrets/foo paths.
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SNAPSHOTD_SENSITIVE_GLOBS", None)
            self.assertTrue(snapshot_state.is_sensitive_path("secrets/foo"))
            self.assertTrue(snapshot_state.is_sensitive_path("credentials"))
            self.assertTrue(snapshot_state.is_sensitive_path("nested/dir/secrets/x"))

    def test_explicit_override_still_honored(self) -> None:
        with mock.patch.dict(os.environ, {"SNAPSHOTD_SENSITIVE_GLOBS": "extra/*,**/leaked.txt"}):
            patterns = snapshot_state._sensitive_patterns()
            # Custom pattern present plus the ``**/leaked.txt`` -> ``leaked.txt``
            # expansion so a top-level leaked.txt is still caught.
            self.assertIn("extra/*", patterns)
            self.assertIn("**/leaked.txt", patterns)
            self.assertIn("leaked.txt", patterns)
            self.assertTrue(snapshot_state.is_sensitive_path("extra/secret"))
            self.assertTrue(snapshot_state.is_sensitive_path("leaked.txt"))
            self.assertTrue(snapshot_state.is_sensitive_path("nested/leaked.txt"))
            # Default-list patterns must NOT leak through when an explicit
            # override is in place — operators sometimes need a different list.
            self.assertFalse(snapshot_state.is_sensitive_path(".env"))


class ProcessFingerprintRegressionTests(unittest.TestCase):
    """State-lane P2 — fingerprint prefers /proc on Linux, ps on darwin."""

    def test_linux_uses_proc_stat_no_subprocess(self) -> None:
        with mock.patch.object(sys, "platform", "linux"):
            with mock.patch.object(
                snapshot_state, "_proc_fingerprint_linux", return_value="linux:42:python"
            ) as proc_mock:
                with mock.patch.object(
                    snapshot_state.subprocess, "run"
                ) as run_mock:
                    fp = snapshot_state.process_fingerprint(1234)
        self.assertEqual(fp, "linux:42:python")
        proc_mock.assert_called_once_with(1234)
        run_mock.assert_not_called()  # /proc path must not fork ps.

    def test_darwin_falls_back_to_ps(self) -> None:
        with mock.patch.object(sys, "platform", "darwin"):
            # Sanity: even if a fake _proc_fingerprint_linux is around, it
            # must not be consulted for non-Linux platforms.
            with mock.patch.object(
                snapshot_state, "_proc_fingerprint_linux", return_value="should-not-see"
            ) as proc_mock:
                fp = snapshot_state.process_fingerprint(os.getpid())
            proc_mock.assert_not_called()
        # Real ps invocation — should produce a non-empty stamp on darwin.
        self.assertIsNotNone(fp)
        self.assertTrue(fp)

    def test_proc_parser_handles_paren_in_comm(self) -> None:
        # Synthesize a /proc/<pid>/stat line whose comm contains ")"; the
        # parser must anchor on the *last* close-paren so field index 22 is
        # still the start_time field.
        fake_stat = b"123 (weird ) name (foo) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 99887766 0 0\n"
        m = mock.mock_open(read_data=fake_stat)
        # cmdline read returns empty bytes.
        m.side_effect = [m.return_value, mock.mock_open(read_data=b"").return_value]
        with mock.patch("builtins.open", m):
            fp = snapshot_state._proc_fingerprint_linux(123)
        self.assertIsNotNone(fp)
        self.assertIn("99887766", fp)


class PathHijackRegressionTests(unittest.TestCase):
    """Shared-lane P1 — PATH hijack must not redirect daemon-side git."""

    def test_clean_git_env_pins_safe_path(self) -> None:
        with mock.patch.dict(os.environ, {"PATH": "/tmp/evil"}):
            env = snapshot_shared._clean_git_env()
            state_env = snapshot_state._clean_git_env()
        # Both modules must scrub the inherited PATH and pin the same
        # trusted sequence so child git processes see the safe directories.
        self.assertEqual(env["PATH"], snapshot_shared._SAFE_PATH)
        self.assertEqual(state_env["PATH"], snapshot_state._SAFE_PATH)
        self.assertEqual(env["PATH"], state_env["PATH"])

    def test_run_git_uses_resolved_binary_under_hijacked_path(self) -> None:
        tmp, repo, _git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        evil_dir = repo.parent / "evil-bin"
        evil_dir.mkdir()
        fake_git = evil_dir / "git"
        # Fake git is intentionally broken so a successful run_git proves the
        # daemon resolved the real binary and ignored PATH.
        fake_git.write_text(
            "#!/bin/sh\necho 'pwned' >&2\nexit 99\n",
            encoding="utf-8",
        )
        fake_git.chmod(fake_git.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        # Reset cached resolution so a stale cache from another test cannot
        # mask the test, and prepend the evil dir to PATH.
        snapshot_shared._GIT_BIN = None
        with mock.patch.dict(os.environ, {"PATH": f"{evil_dir}:{os.environ.get('PATH', '')}"}):
            # run_git must NOT resolve the evil binary; it must use the
            # absolute path returned by ``git_bin()`` (resolved via the
            # pinned safe PATH or SNAPSHOTD_GIT_BIN).
            out = snapshot_shared.run_git(repo, "rev-parse", "--show-toplevel")
        self.assertTrue(out)
        # And the resolved binary must live outside the evil dir.
        resolved = snapshot_shared.git_bin()
        self.assertFalse(
            str(resolved).startswith(str(evil_dir)),
            f"daemon git resolved to attacker-controlled path: {resolved}",
        )

    def test_state_module_uses_same_git_binary(self) -> None:
        # Confirms the coordination point: both files agree on the resolved
        # binary so the mirror copies of _clean_git_env stay in sync.
        snapshot_shared._GIT_BIN = None
        a = snapshot_shared.git_bin()
        # snapshot_state imports git_bin from snapshot_shared, so they must
        # share the same module-level cache.
        from snapshot_state import git_bin as state_git_bin

        self.assertEqual(a, state_git_bin())


class FastForwardIncarnationTests(unittest.TestCase):
    """Shared-lane P1 — fast-forward commits keep generation steady."""

    def test_fast_forward_does_not_bump_generation(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        ctx_before = snapshot_state.repo_context(repo, git_dir)
        gen_before = ctx_before["branch_generation"]

        # Make a fast-forward commit on the same branch.
        (repo / "a.txt").write_text("hello\n", encoding="utf-8")
        git(repo, "add", "a.txt")
        git(repo, "commit", "-m", "ff commit")

        ctx_after = snapshot_state.repo_context(repo, git_dir)
        self.assertEqual(
            ctx_after["branch_generation"],
            gen_before,
            "fast-forward commit must not bump branch_generation",
        )

    def test_non_fast_forward_does_bump_generation(self) -> None:
        tmp, repo, git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        # First commit + register.
        (repo / "a.txt").write_text("v1\n", encoding="utf-8")
        git(repo, "add", "a.txt")
        git(repo, "commit", "-m", "v1")
        ctx_before = snapshot_state.repo_context(repo, git_dir)
        gen_before = ctx_before["branch_generation"]

        # Force a non-FF: hard-reset to the initial empty commit, then
        # commit a divergent v1' so previous_head is not an ancestor of head.
        first = git(repo, "rev-list", "--max-parents=0", "HEAD").stdout.strip()
        git(repo, "reset", "--hard", first)
        (repo / "a.txt").write_text("vDifferent\n", encoding="utf-8")
        git(repo, "add", "a.txt")
        git(repo, "commit", "-m", "divergent")

        ctx_after = snapshot_state.repo_context(repo, git_dir)
        self.assertGreater(
            ctx_after["branch_generation"],
            gen_before,
            "non-fast-forward HEAD movement must bump branch_generation",
        )

    def test_incarnation_token_is_content_hash(self) -> None:
        tmp, repo, _git_dir = init_repo()
        self.addCleanup(tmp.cleanup)

        ref = "refs/heads/main"
        token1 = snapshot_shared.branch_incarnation_token(repo, ref)
        # Token format: rev:<hex> for an existing ref.
        self.assertTrue(token1.startswith("rev:"), token1)

        # A fast-forward commit changes the SHA so the token changes too —
        # but the registry's ancestor check is what protects against bumps,
        # not token identity. The token reflects content, not mtime.
        (repo / "b.txt").write_text("x\n", encoding="utf-8")
        git(repo, "add", "b.txt")
        git(repo, "commit", "-m", "next")
        token2 = snapshot_shared.branch_incarnation_token(repo, ref)
        self.assertNotEqual(token1, token2)
        self.assertTrue(token2.startswith("rev:"))

        # Missing ref returns the sentinel.
        missing = snapshot_shared.branch_incarnation_token(repo, "refs/heads/does-not-exist")
        self.assertEqual(missing, "missing")


if __name__ == "__main__":
    unittest.main()

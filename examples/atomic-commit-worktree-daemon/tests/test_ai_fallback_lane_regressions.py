"""Regression tests for the daemon AI / command / deterministic message
fallback chain in ``snapshot-replay.py``.

The daemon's commit-message resolution is a layered fallback:

    1. ``capture_events.message`` (memoized — typically from a previous
       AI batch run that succeeded but couldn't yet commit).
    2. ``SNAPSHOTD_COMMIT_MESSAGE_CMD`` (a per-event shell hook).
    3. ``snapshot_state.build_message`` — the deterministic helper.

In addition, when ``SNAPSHOTD_AI_ENABLE=1`` and ``OPENAI_API_KEY`` is set,
``_replay_pending_events_locked`` runs an AI pre-pass that batches
events through OpenAI's chat completions endpoint and writes the
returned subject/body into ``capture_events.message`` for the commit
loop to pick up. The pre-pass is bounded by
``SNAPSHOTD_AI_MAX_QUEUE_DEPTH`` so a sudden backlog doesn't fan out
into an expensive batch request.

These tests lock in the contract for each rung of that chain and the
backlog/redaction guards. Every test reloads ``snapshot-replay.py``
under freshly-monkeypatched env so module-level constants
(``SNAPSHOTD_AI_ENABLE``, ``OPENAI_API_KEY``, etc., captured at import
time) reflect the test's intent rather than whatever the developer's
shell happens to have set. ``urllib.request.urlopen`` is monkeypatched
to a tripwire by default; any test that needs an AI response replaces
the tripwire with a stub that returns an in-memory JSON payload so the
suite never touches the network.
"""

from __future__ import annotations

import json
import urllib.error as urllib_error
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List

import pytest

from test_worktree_daemon import (
    init_repo,
    load_example_module,
)

import snapshot_state  # noqa: E402  (made importable by test_worktree_daemon)


# Env keys that gate the AI/command path. Every test starts by deleting
# all of them so leftover developer-shell state cannot bleed in. Keep
# this list in sync with snapshot-replay.py's module-level reads.
_AI_ENV_KEYS = (
    "SNAPSHOTD_AI_ENABLE",
    "SNAPSHOTD_AI_MAX_QUEUE_DEPTH",
    "SNAPSHOTD_AI_CHUNK_SIZE",
    "SNAPSHOTD_COMMIT_MESSAGE_CMD",
    "SNAPSHOTD_SENSITIVE_GLOBS",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_API_TIMEOUT",
)


def _isolate_ai_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Drop every AI/command env var the daemon reads at import time.

    Called at the top of every test in this module. Keeps individual
    cases hermetic regardless of CI worker leakage or developer shells.
    """
    for key in _AI_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def _fresh_replay(name: str):
    """Load ``snapshot-replay.py`` as a fresh module.

    The replay module reads env-derived constants at import time, so
    each test that wants a different AI/command configuration must
    re-import after ``monkeypatch.setenv``. ``load_example_module``
    creates a uniquely-named module via ``importlib.util`` so we never
    collide with an earlier test's module object.
    """
    return load_example_module(name, "snapshot-replay.py")


def _record_one_event(conn, repo: Path, git_dir: Path, *, name: str, body: str) -> int:
    """Helper: write ``name`` with ``body`` and queue a pending create event."""
    blob = snapshot_state.capture_blob_for_text(repo, body)
    (repo / name).parent.mkdir(parents=True, exist_ok=True)
    (repo / name).write_text(body, encoding="utf-8")
    ctx = snapshot_state.repo_context(repo, git_dir)
    seq = snapshot_state.record_event(
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
    return seq


def _make_urlopen_tripwire():
    """Return a urlopen replacement that fails the test if invoked.

    Tests that should not touch the network install this; if the
    code-under-test mistakenly issues an HTTP request the resulting
    AssertionError surfaces immediately rather than racing a real
    socket open.
    """

    def _tripwire(req, timeout=None):  # noqa: ARG001
        raise AssertionError(
            "urllib.request.urlopen was called but the test forbids network "
            "access; a regression in the AI gating logic is likely."
        )

    return _tripwire


def _make_urlopen_returning(payload: Dict[str, Any], capture: List[bytes] | None = None):
    """Return a urlopen stub that yields ``payload`` as a chat-completions response.

    ``capture`` (when provided) accumulates the raw request body bytes
    so a test can inspect what would have been sent to OpenAI — used by
    the redaction test to confirm sensitive diffs never leave the
    daemon. The returned stub mimics the parts of ``http.client.HTTPResponse``
    that ``batch_ai_messages`` actually uses (``read`` + context manager).
    """
    body = {
        "choices": [
            {
                "message": {
                    "content": json.dumps(payload),
                }
            }
        ]
    }
    body_bytes = json.dumps(body).encode("utf-8")

    class _Resp:
        def __init__(self) -> None:
            self._buf = BytesIO(body_bytes)

        def read(self) -> bytes:
            return self._buf.read()

        def __enter__(self):
            return self

        def __exit__(self, *exc) -> None:
            return None

    def _urlopen(req, timeout=None):  # noqa: ARG001
        if capture is not None:
            try:
                capture.append(req.data or b"")
            except AttributeError:
                capture.append(b"")
        return _Resp()

    return _urlopen


# --------------------------------------------------------------------------- #
# 1. Deterministic fallback — AI off, no command set.
# --------------------------------------------------------------------------- #


def test_deterministic_message_when_ai_off_and_no_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no AI and no command env, replay must use ``build_message``.

    Locks in backward compatibility: the deterministic format
    ``Add <name>\\n\\n- create <path>\\n- seq <N> on <branch>`` is the
    historical default and downstream tooling (log scrapers, archive
    tools) parses it. Any future refactor that swaps ``build_message``
    for a different deterministic helper must break this test loudly.
    """
    _isolate_ai_env(monkeypatch)
    tmp, repo, git_dir = init_repo()
    try:
        replay = _fresh_replay("snapshot_replay_ai_default_det")
        # Defense in depth: even with the env cleared, an aliased
        # ``urlopen`` somewhere would surface here as a failure rather
        # than as a silent network call.
        monkeypatch.setattr(replay.urllib_request, "urlopen", _make_urlopen_tripwire())

        conn = snapshot_state.ensure_state(git_dir)
        try:
            seq = _record_one_event(conn, repo, git_dir, name="clean.txt", body="clean\n")
            published = replay.replay_pending_events(conn, repo, git_dir)
            assert published == 1
            row = conn.execute(
                "SELECT state, commit_oid, message FROM capture_events WHERE seq=?",
                (seq,),
            ).fetchone()
            assert row["state"] == "published"
            # message is NOT memoized for the deterministic path — only
            # the AI pre-pass writes capture_events.message.
            assert row["message"] is None
            commit_msg = _git_commit_message(repo, row["commit_oid"])
            assert commit_msg.startswith("Add clean.txt")
            assert "- create clean.txt" in commit_msg
            assert f"- seq {seq} on refs/heads/main" in commit_msg
        finally:
            conn.close()
    finally:
        tmp.cleanup()


# --------------------------------------------------------------------------- #
# 2. SNAPSHOTD_COMMIT_MESSAGE_CMD — output drives the commit subject.
# --------------------------------------------------------------------------- #


def test_command_message_overrides_deterministic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A configured ``SNAPSHOTD_COMMIT_MESSAGE_CMD`` wins over the default.

    Uses ``printf`` (hermetic, no network, no shell side effects) so
    the test asserts on the controller logic — payload piped to stdin,
    sanitized stdout becomes the subject — rather than any real
    AI integration. The command output also bypasses
    ``capture_events.message`` because that field is reserved for
    AI batch results; the command runs per-event in the commit loop.
    """
    _isolate_ai_env(monkeypatch)
    monkeypatch.setenv(
        "SNAPSHOTD_COMMIT_MESSAGE_CMD",
        "printf 'custom subject from cmd\\n'",
    )
    tmp, repo, git_dir = init_repo()
    try:
        replay = _fresh_replay("snapshot_replay_ai_cmd")
        # Even though command-mode never reaches OpenAI, harden the
        # gate: any urlopen call here would prove the AI pre-pass is
        # being entered when only the command path was configured.
        monkeypatch.setattr(replay.urllib_request, "urlopen", _make_urlopen_tripwire())

        conn = snapshot_state.ensure_state(git_dir)
        try:
            seq = _record_one_event(conn, repo, git_dir, name="cmd.txt", body="cmd\n")
            published = replay.replay_pending_events(conn, repo, git_dir)
            assert published == 1
            row = conn.execute(
                "SELECT state, commit_oid FROM capture_events WHERE seq=?",
                (seq,),
            ).fetchone()
            assert row["state"] == "published"
            commit_msg = _git_commit_message(repo, row["commit_oid"])
            # sanitize_message normalizes whitespace; the literal subject
            # printed by the command must lead the message.
            assert commit_msg.startswith("custom subject from cmd"), (
                f"expected command output to drive the subject; got {commit_msg!r}"
            )
        finally:
            conn.close()
    finally:
        tmp.cleanup()


# --------------------------------------------------------------------------- #
# 3. AI disabled but API key present — must not call OpenAI.
# --------------------------------------------------------------------------- #


def test_api_key_alone_does_not_enable_ai(monkeypatch: pytest.MonkeyPatch) -> None:
    """``OPENAI_API_KEY`` set but ``SNAPSHOTD_AI_ENABLE`` falsy => no HTTP.

    A common deployment pitfall is exporting the API key in the user's
    shell for unrelated tooling. The daemon must require an explicit
    ``SNAPSHOTD_AI_ENABLE`` opt-in; otherwise any developer with
    ``OPENAI_API_KEY`` exported would silently start sending diffs to
    OpenAI the first time the daemon ran.
    """
    _isolate_ai_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-used")
    # Note: SNAPSHOTD_AI_ENABLE deliberately not set.
    tmp, repo, git_dir = init_repo()
    try:
        replay = _fresh_replay("snapshot_replay_ai_keyonly")
        monkeypatch.setattr(replay.urllib_request, "urlopen", _make_urlopen_tripwire())
        # Sanity: the loaded module has the gate evaluated to False.
        assert replay.SNAPSHOTD_AI_ENABLE is False

        conn = snapshot_state.ensure_state(git_dir)
        try:
            seq = _record_one_event(conn, repo, git_dir, name="noai.txt", body="noai\n")
            published = replay.replay_pending_events(conn, repo, git_dir)
            assert published == 1
            row = conn.execute(
                "SELECT state, message, commit_oid FROM capture_events WHERE seq=?",
                (seq,),
            ).fetchone()
            assert row["state"] == "published"
            assert row["message"] is None  # AI pre-pass skipped, nothing memoized.
            commit_msg = _git_commit_message(repo, row["commit_oid"])
            assert "- seq" in commit_msg  # deterministic format trailer.
        finally:
            conn.close()
    finally:
        tmp.cleanup()


# --------------------------------------------------------------------------- #
# 4. AI enabled, mocked OpenAI response — message is persisted.
# --------------------------------------------------------------------------- #


def test_ai_batch_response_persisted_to_capture_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Successful batch_ai_messages writes capture_events.message AND uses it.

    Two assertions in one test because the persistence is the
    contract: a row that successfully fetched an AI message must
    expose it on the row so a daemon crash mid-batch lets the next
    replay reuse it (skipping the cost of another API call). Also
    confirms publish state transitions remain ``pending → publishing
    → published`` even when AI succeeds — covers required case #8.
    """
    _isolate_ai_env(monkeypatch)
    monkeypatch.setenv("SNAPSHOTD_AI_ENABLE", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    tmp, repo, git_dir = init_repo()
    try:
        replay = _fresh_replay("snapshot_replay_ai_ok")
        assert replay.SNAPSHOTD_AI_ENABLE is True

        conn = snapshot_state.ensure_state(git_dir)
        try:
            seq = _record_one_event(
                conn, repo, git_dir, name="ai.txt", body="hello ai\n"
            )
            payload = {
                "messages": [
                    {
                        "seq": seq,
                        "subject": "AI generated subject",
                        "body": "- explain why this change happened",
                    }
                ]
            }
            monkeypatch.setattr(
                replay.urllib_request,
                "urlopen",
                _make_urlopen_returning(payload),
            )

            published = replay.replay_pending_events(conn, repo, git_dir)
            assert published == 1

            row = conn.execute(
                "SELECT state, message, commit_oid FROM capture_events WHERE seq=?",
                (seq,),
            ).fetchone()
            # (a) capture_events.message was memoized.
            assert row["message"] is not None, (
                "AI pre-pass produced a message but did not persist it to "
                "capture_events.message — a crash mid-batch would force a "
                "second OpenAI call on the next replay cycle."
            )
            assert "AI generated subject" in row["message"]
            # (b) commit message reflects the AI text (sanitized).
            commit_msg = _git_commit_message(repo, row["commit_oid"])
            assert commit_msg.startswith("AI generated subject"), commit_msg
            # (c) publish_state landed at ``published`` — the AI path
            # must not skip the publishing/published transitions.
            ps = conn.execute(
                "SELECT status, event_seq FROM publish_state WHERE id=1"
            ).fetchone()
            assert ps["status"] == "published"
            assert ps["event_seq"] == seq
            assert row["state"] == "published"
        finally:
            conn.close()
    finally:
        tmp.cleanup()


# --------------------------------------------------------------------------- #
# 5. OpenAI failure — fall back to deterministic, do not fail the event.
# --------------------------------------------------------------------------- #


def test_openai_url_error_falls_back_to_deterministic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A URLError from OpenAI must NEVER mark the event failed/blocked.

    Network blips on the AI path are routine; if they propagated as
    event failures, every transient OpenAI outage would fill the
    daemon's quarantine bin with otherwise-valid edits. The contract
    is: AI is best-effort, the deterministic helper is always
    available, and the commit succeeds either way.
    """
    _isolate_ai_env(monkeypatch)
    monkeypatch.setenv("SNAPSHOTD_AI_ENABLE", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    tmp, repo, git_dir = init_repo()
    try:
        replay = _fresh_replay("snapshot_replay_ai_urlerror")

        def _raising(req, timeout=None):  # noqa: ARG001
            raise urllib_error.URLError("simulated network failure")

        monkeypatch.setattr(replay.urllib_request, "urlopen", _raising)

        conn = snapshot_state.ensure_state(git_dir)
        try:
            seq = _record_one_event(
                conn, repo, git_dir, name="failover.txt", body="net dead\n"
            )
            published = replay.replay_pending_events(conn, repo, git_dir)
            assert published == 1, "URLError must not abort the publish"
            row = conn.execute(
                "SELECT state, error, message, commit_oid FROM capture_events WHERE seq=?",
                (seq,),
            ).fetchone()
            assert row["state"] == "published"
            assert row["error"] is None
            assert row["message"] is None  # nothing memoized when AI failed.
            commit_msg = _git_commit_message(repo, row["commit_oid"])
            # Deterministic format reaches the commit.
            assert commit_msg.startswith("Add failover.txt"), commit_msg
            assert f"- seq {seq} on refs/heads/main" in commit_msg
        finally:
            conn.close()
    finally:
        tmp.cleanup()


# --------------------------------------------------------------------------- #
# 6. SNAPSHOTD_AI_MAX_QUEUE_DEPTH — backlog skips the AI pre-pass.
# --------------------------------------------------------------------------- #


def test_ai_skipped_when_backlog_exceeds_max_queue_depth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A backlog > ``SNAPSHOTD_AI_MAX_QUEUE_DEPTH`` skips the AI pre-pass.

    Rationale: the AI batch is a synchronous, network-bounded cost.
    A daemon catching up on a 2000-event backlog after a long
    stop must not hold publish_lock for 30s+ of HTTPS round-trips —
    operators set a low max-queue-depth (default 2) so AI only fires
    on the steady-state path. We assert urlopen was never called.
    """
    _isolate_ai_env(monkeypatch)
    monkeypatch.setenv("SNAPSHOTD_AI_ENABLE", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("SNAPSHOTD_AI_MAX_QUEUE_DEPTH", "1")
    tmp, repo, git_dir = init_repo()
    try:
        replay = _fresh_replay("snapshot_replay_ai_backlog")
        assert replay.SNAPSHOTD_AI_MAX_QUEUE_DEPTH == 1
        monkeypatch.setattr(replay.urllib_request, "urlopen", _make_urlopen_tripwire())

        conn = snapshot_state.ensure_state(git_dir)
        try:
            # Three events => len(pending) == 3 > max_queue_depth(1).
            for name, body in (
                ("a.txt", "alpha\n"),
                ("b.txt", "bravo\n"),
                ("c.txt", "charlie\n"),
            ):
                _record_one_event(conn, repo, git_dir, name=name, body=body)
            published = replay.replay_pending_events(conn, repo, git_dir)
            assert published == 3
            rows = conn.execute(
                "SELECT state, message FROM capture_events ORDER BY seq"
            ).fetchall()
            assert [r["state"] for r in rows] == ["published"] * 3
            # No AI pre-pass ran => no message memoization for any event.
            assert all(r["message"] is None for r in rows), (
                "AI pre-pass appears to have run despite backlog>max_queue_depth"
            )
        finally:
            conn.close()
    finally:
        tmp.cleanup()


# --------------------------------------------------------------------------- #
# 7. Sensitive path redaction.
# --------------------------------------------------------------------------- #


def test_sensitive_paths_are_redacted_unit() -> None:
    """``_path_matches_sensitive`` flags the canonical secret paths.

    Unit-style assertion (no replay needed). The full-payload
    redaction is exercised in ``test_sensitive_path_redacted_in_ai_payload``
    below; this cheaper test catches a future regression that
    accidentally narrows the default sensitive globs.
    """
    # Use a fresh module so we know the sensitive-globs env was empty.
    replay = _fresh_replay("snapshot_replay_sensitive_unit")
    assert replay._path_matches_sensitive(".env") is True
    assert replay._path_matches_sensitive("config/.env.production") is True
    assert replay._path_matches_sensitive("secrets/api_token") is True
    assert replay._path_matches_sensitive("docs/readme.md") is False
    assert replay._path_matches_sensitive(None) is False
    assert replay._path_matches_sensitive("") is False


def test_sensitive_path_redacted_in_ai_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A `.env` op's diff is replaced with a redaction marker before send.

    The capture-lane already filters sensitive top-level paths, but
    nested ``secrets/...`` files can reach the replay queue (see
    test_polling_skips_ignored_and_sensitive_files for the capture
    side). This test exercises the replay-side redaction by inspecting
    the body bytes that ``batch_ai_messages`` would have POSTed.
    """
    _isolate_ai_env(monkeypatch)
    monkeypatch.setenv("SNAPSHOTD_AI_ENABLE", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    tmp, repo, git_dir = init_repo()
    try:
        replay = _fresh_replay("snapshot_replay_ai_redact")
        captured: List[bytes] = []
        # Return a deliberately empty messages array so the AI path
        # falls through to deterministic — the test is about what
        # WAS sent, not what came back.
        monkeypatch.setattr(
            replay.urllib_request,
            "urlopen",
            _make_urlopen_returning({"messages": []}, capture=captured),
        )

        conn = snapshot_state.ensure_state(git_dir)
        try:
            secret_body = "AWS_SECRET_ACCESS_KEY=should-never-leave-the-machine\n"
            seq = _record_one_event(
                conn,
                repo,
                git_dir,
                name="secrets/credentials.txt",
                body=secret_body,
            )
            published = replay.replay_pending_events(conn, repo, git_dir)
            assert published == 1
        finally:
            conn.close()

        assert captured, "AI pre-pass never POSTed; redaction path untested"
        body_text = captured[0].decode("utf-8", errors="replace")
        # The literal secret must not appear anywhere in what we'd
        # have sent to OpenAI.
        assert "AWS_SECRET_ACCESS_KEY" not in body_text, (
            "raw secret leaked into the OpenAI payload — redaction failed"
        )
        assert "should-never-leave-the-machine" not in body_text
        # Positive assertion: the redaction marker is present so we
        # know the op survived (just with its diff scrubbed) rather
        # than being silently dropped.
        assert "<redacted: sensitive path>" in body_text, (
            "expected redaction marker; the op may have been omitted entirely "
            "or the redaction text changed"
        )
        # The path itself can appear (it's metadata, not content) —
        # we only redact the diff body. Confirm the seq round-trips
        # so the AI knows which event to address (when it returns).
        # Decode the request body as JSON and walk the structure rather
        # than relying on string encoding variants.
        body_json = json.loads(body_text)
        # The events list is embedded as a JSON string inside the chat
        # user-message content; decode it to extract seq values.
        seqs_in_payload: list[int] = []
        for msg in body_json.get("messages", []):
            content = msg.get("content", "")
            if isinstance(content, str):
                try:
                    inner = json.loads(content)
                    seqs_in_payload.extend(
                        e.get("seq") for e in inner.get("events", []) if "seq" in e
                    )
                except (json.JSONDecodeError, AttributeError):
                    pass
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        text = part.get("text", "")
                        try:
                            inner = json.loads(text)
                            seqs_in_payload.extend(
                                e.get("seq") for e in inner.get("events", []) if "seq" in e
                            )
                        except (json.JSONDecodeError, AttributeError):
                            pass
        assert seq in seqs_in_payload, (
            f"seq={seq} not found in OpenAI payload events; "
            f"seqs present: {seqs_in_payload!r}; body[:200]={body_text[:200]!r}"
        )
    finally:
        tmp.cleanup()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _git_commit_message(repo: Path, commit_oid: str) -> str:
    """Read the full commit message body for ``commit_oid``.

    Uses the local ``git`` helper from test_worktree_daemon so the
    same env scrubbing (``GIT_CONFIG_GLOBAL=/dev/null`` etc.) applies
    here — a developer's commit template/signing config cannot
    perturb the message we read back.
    """
    from test_worktree_daemon import git as git_helper

    proc = git_helper(repo, "log", "-1", "--format=%B", commit_oid)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.rstrip("\n")

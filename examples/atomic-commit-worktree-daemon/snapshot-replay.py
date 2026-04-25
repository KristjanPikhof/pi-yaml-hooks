#!/usr/bin/env python3
"""Replay captured snapshot events into real git commits.

The replay path is deliberately conservative: it loads a worktree-local SQLite
queue, validates branch ownership through the shared registry helper, creates
one commit per captured event by default, and publishes the result with a
compare-and-swap ``git update-ref``.
"""

from __future__ import annotations

import argparse
import difflib
import ipaddress
import json
import os
import re
import shlex
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from snapshot_state import (
    _clean_git_env,
    apply_ops_to_index,
    build_message,
    ensure_state,
    git_bin,
    index_path,
    is_sensitive_path,
    load_ops,
    load_pending_events,
    mark_event_published,
    publish_lock,
    PublishLockBusy,
    repo_context,
    resolve_repo_paths,
    set_daemon_meta,
    set_event_message,
    snapshot_state_for_index,
    status_snapshot,
    transaction,
    update_publish_state,
)


def _publish_lock_timeout() -> float:
    """Per-call read of ``SNAPSHOTD_PUBLISH_LOCK_TIMEOUT``.

    Captured at import historically; callers now read on each invocation
    so monkeypatched env in tests and on-the-fly operator overrides
    take effect without reimporting the module.
    """
    raw = os.environ.get("SNAPSHOTD_PUBLISH_LOCK_TIMEOUT")
    if raw is None or not raw.strip():
        return 30.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 30.0


# Module-level alias preserved for tests that read the constant at
# import time after ``monkeypatch.setenv``. Production helpers below
# call ``_publish_lock_timeout()`` directly so they pick up env changes
# without requiring a module reload.
REPLAY_PUBLISH_LOCK_TIMEOUT = _publish_lock_timeout()


def _replay_batch_max() -> int:
    """How many events the replay loop will process per ``publish_lock`` acquisition.

    Bounded so a deep backlog does not monopolize the lock for the entire
    drain — sibling tools and the daemon's flush ackers need a chance to
    take the lock between batches. ``SNAPSHOTD_REPLAY_BATCH_MAX`` overrides
    the default of 200; non-positive or unparseable values fall back to it.
    """
    raw = os.environ.get("SNAPSHOTD_REPLAY_BATCH_MAX")
    if raw is None:
        return 200
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 200
    if value <= 0:
        return 200
    return value


# --------------------------------------------------------------------------- #
# Commit-message generation (port of snapshot-worker helpers, daemon-adapted)
#
# These helpers are intentionally pure — they never mutate the SQLite queue or
# the publish_state row. Callers may use the returned strings as commit
# messages but DB state changes remain the caller's responsibility. The
# daemon's ``CaptureEvent`` shape lacks ``tool_name`` and ``source`` columns
# that snapshot-worker exposes; this module substitutes the literal
# ``"daemon"`` for the tool name and omits the ``source`` field entirely so
# fallback output stays deterministic when the AI/command paths are off.
# --------------------------------------------------------------------------- #


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes"}


def _env_int(name: str, default: int, *, lo: Optional[int] = None, hi: Optional[int] = None) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        value = default
    else:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = default
    if lo is not None and value < lo:
        value = lo
    if hi is not None and value > hi:
        value = hi
    return value


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _ai_enable() -> bool:
    return _env_truthy("SNAPSHOTD_AI_ENABLE")


def _ai_max_queue_depth() -> int:
    return _env_int("SNAPSHOTD_AI_MAX_QUEUE_DEPTH", 2, lo=0)


def _ai_chunk_size() -> int:
    return _env_int("SNAPSHOTD_AI_CHUNK_SIZE", 20, lo=1, hi=100)


def _commit_message_cmd() -> str:
    return os.environ.get("SNAPSHOTD_COMMIT_MESSAGE_CMD", "").strip()


def _openai_api_key() -> str:
    return os.environ.get("OPENAI_API_KEY", "")


def _openai_base_url() -> str:
    return os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")


def _openai_model() -> str:
    return os.environ.get("OPENAI_MODEL", "gpt-5.4-mini")


def _openai_api_timeout() -> float:
    return _env_float("OPENAI_API_TIMEOUT", 15.0)


def _ai_max_blob_bytes() -> int:
    """Per-call cap on cat-file blob bodies in the AI/diff pre-pass.

    Defaults to 1 MiB. Anything larger is replaced with the
    ``<oversized>`` sentinel so a giant binary cannot blow process
    memory or balloon the OpenAI prompt.
    """
    return _env_int("SNAPSHOTD_AI_MAX_BLOB_BYTES", 1 << 20, lo=0)


# Module-level constants captured at import time exist only to keep the
# existing test contract (which reloads the module after monkeypatching
# env). Production helpers below always call the per-call helpers above
# so a live env change is observed without reimport.
SNAPSHOTD_AI_ENABLE = _ai_enable()
SNAPSHOTD_AI_MAX_QUEUE_DEPTH = _ai_max_queue_depth()
SNAPSHOTD_AI_CHUNK_SIZE = _ai_chunk_size()
SNAPSHOTD_COMMIT_MESSAGE_CMD = _commit_message_cmd()

OPENAI_API_KEY = _openai_api_key()
OPENAI_BASE_URL = _openai_base_url()
OPENAI_MODEL = _openai_model()
OPENAI_API_TIMEOUT = _openai_api_timeout()


# Sensitive blob sentinel. Returned by ``batch_cat_file`` for any blob
# whose declared size exceeds the per-call cap; the diff renderer then
# emits the standard ``<binary content changed>`` marker so downstream
# code never sees the raw body.
_OVERSIZED_BLOB: bytes = b"<oversized>"


def _path_matches_sensitive(path: Optional[str]) -> bool:
    """Compatibility shim around ``snapshot_state.is_sensitive_path``.

    Kept so existing tests that import the helper by name continue to
    pass while the canonical implementation lives in ``snapshot_state``
    (single source of truth for the default-deny glob list).
    """
    if not path:
        return False
    return is_sensitive_path(path)


AI_SYSTEM_PROMPT = (
    "You are a git commit message generator.\n"
    "Line 1: imperative subject, max 50 chars, no trailing period.\n"
    "Blank line, then body bullets starting with '- ', wrapped at 72 chars.\n"
    "Describe WHAT changed and WHY. No questions, no preamble.\n"
    "Output only the commit message."
)

BATCH_SYSTEM_PROMPT = (
    "You are a git commit message generator for a batch of snapshot events.\n"
    "Input: one JSON payload listing events with seq, tool, paths, and diffs.\n"
    "Output: a JSON object matching the provided schema with a 'messages'\n"
    "array. Produce one item per input event, preserving its seq verbatim.\n"
    "For each item:\n"
    "- 'subject': imperative, max 50 chars, no trailing period.\n"
    "- 'body': bullet list ('- ' prefix) describing WHAT changed and WHY,\n"
    "  wrapped at 72 chars. One line per bullet. No preamble, no questions.\n"
    "Do not emit any text outside the JSON object."
)

BATCH_RESPONSE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["messages"],
    "properties": {
        "messages": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["seq", "subject", "body"],
                "properties": {
                    "seq": {"type": "integer"},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                },
            },
        },
    },
}


# Literal tool name used in deterministic messages and AI prompts. The daemon
# does not capture per-write tool identity the way snapshot-worker does, so we
# tag every produced message with ``"daemon"`` to keep formatting consistent.
DAEMON_TOOL_NAME = "daemon"


def _decode_blob_text(data: bytes) -> Optional[str]:
    if b"\x00" in data:
        return None
    return data.decode("utf-8", errors="replace")


def batch_cat_file(repo_root: Path, oids: Iterable[str]) -> Dict[str, bytes]:
    """Resolve many blob OIDs in one ``git cat-file --batch`` call.

    Returns a mapping of OID to raw blob bytes. Missing or non-blob OIDs are
    silently dropped — callers fall back to ``<binary content changed>`` or
    deterministic messaging when a blob cannot be resolved.
    """
    unique = sorted({oid for oid in oids if oid and set(oid) != {"0"}})
    if not unique:
        return {}
    proc = subprocess.Popen(
        ["git", "cat-file", "--batch"],
        cwd=str(repo_root),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
    )
    assert proc.stdin is not None and proc.stdout is not None
    try:
        proc.stdin.write(("\n".join(unique) + "\n").encode("utf-8"))
        proc.stdin.close()
    except Exception:
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        return {}

    out: Dict[str, bytes] = {}
    try:
        for _ in unique:
            header = proc.stdout.readline()
            if not header:
                break
            header = header.rstrip(b"\n")
            parts = header.split(b" ")
            if len(parts) < 3 or parts[1] != b"blob":
                continue
            oid = parts[0].decode()
            try:
                size = int(parts[2])
            except ValueError:
                continue
            data = b""
            while len(data) < size:
                chunk = proc.stdout.read(size - len(data))
                if not chunk:
                    break
                data += chunk
            proc.stdout.read(1)  # trailing newline
            out[oid] = data
    finally:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    return out


def op_diff_text(op: Mapping[str, Any], blobs: Mapping[str, bytes]) -> str:
    """Render a unified diff for one op using already-fetched blob bytes.

    Returns ``"<binary content changed>"`` when either side is non-text, and
    ``"<no textual diff>"`` when before and after are byte-identical. Output
    is capped at 4000 chars so a giant change cannot blow the prompt budget.
    """
    kind = op.get("op")
    path = op.get("path") or ""
    if kind == "create":
        before_label, after_label = "/dev/null", path
        before_bytes = b""
        after_bytes = blobs.get(op.get("after_oid") or "", b"")
    elif kind == "modify":
        before_label = after_label = path
        before_bytes = blobs.get(op.get("before_oid") or "", b"")
        after_bytes = blobs.get(op.get("after_oid") or "", b"")
    elif kind == "delete":
        before_label, after_label = path, "/dev/null"
        before_bytes = blobs.get(op.get("before_oid") or "", b"")
        after_bytes = b""
    else:  # rename / mode / symlink
        before_label = op.get("old_path") or path
        after_label = path
        before_bytes = blobs.get(op.get("before_oid") or "", b"")
        after_bytes = blobs.get(op.get("after_oid") or "", b"")

    before_text = _decode_blob_text(before_bytes)
    after_text = _decode_blob_text(after_bytes)
    if before_text is None or after_text is None:
        return "<binary content changed>"

    diff = list(
        difflib.unified_diff(
            before_text.splitlines(),
            after_text.splitlines(),
            fromfile=before_label,
            tofile=after_label,
            lineterm="",
            n=3,
        )
    )
    if not diff:
        return "<no textual diff>"
    return "\n".join(diff)[:4000]


def compute_diffs_for_event(
    repo_root: Path, ops: List[Mapping[str, Any]]
) -> Dict[int, str]:
    """Return ``{op_index: diff_text}`` for every op in one event.

    Resolves all referenced blob OIDs in a single ``git cat-file --batch``
    call. Any path matching the sensitive glob list is replaced with a
    redaction marker rather than its diff; callers do not need to reapply
    the filter.
    """
    if not ops:
        return {}
    needed_oids: List[str] = []
    for op in ops:
        for key in ("before_oid", "after_oid"):
            oid = op.get(key)
            if oid:
                needed_oids.append(str(oid))
    blobs = batch_cat_file(repo_root, needed_oids) if needed_oids else {}
    diffs: Dict[int, str] = {}
    for idx, op in enumerate(ops):
        if _path_matches_sensitive(op.get("path")) or (
            op.get("op") == "rename" and _path_matches_sensitive(op.get("old_path"))
        ):
            diffs[idx] = "<redacted: sensitive path>"
            continue
        diffs[idx] = op_diff_text(op, blobs)
    return diffs


def _redacted_op_payload(
    op: Mapping[str, Any], idx: int, diffs: Mapping[int, str]
) -> Tuple[Dict[str, Any], bool]:
    """Build a single op payload, scrubbing path/old_path/diff when sensitive.

    Returns ``(entry, sensitive)`` so callers can also drop the original
    path from any sibling ``paths`` array. The diff is replaced with
    ``"<redacted: sensitive path>"`` regardless of whether
    ``compute_diffs_for_event`` already redacted it — this keeps the
    helper standalone for the ``ai_message_via_command`` path which
    does not flow through the diff loop's per-op redaction.
    """
    sensitive = _path_matches_sensitive(op.get("path")) or (
        op.get("op") == "rename" and _path_matches_sensitive(op.get("old_path"))
    )
    if sensitive:
        return (
            {
                "op": op.get("op"),
                "path": "<redacted-path>",
                "old_path": "<redacted-path>" if op.get("old_path") else None,
                "diff": "<redacted: sensitive path>",
            },
            True,
        )
    return (
        {
            "op": op.get("op"),
            "path": op.get("path"),
            "old_path": op.get("old_path"),
            "diff": diffs.get(idx, ""),
        },
        False,
    )


def _basename(path: Optional[str]) -> str:
    if not path:
        return ""
    name = path.rstrip("/").rsplit("/", 1)[-1]
    return name or path


def _trim_subject(subject: str, limit: int = 50) -> str:
    """Trim a commit subject to ``limit`` chars, preferring a word boundary.

    Mirrors snapshot-worker — never cuts mid-token; falls back to a hard cut
    only when no boundary lies in the second half of the budget.
    """
    subject = subject.strip()
    if len(subject) <= limit:
        return subject
    head = subject[: limit - 1]
    boundary = max(head.rfind(" "), head.rfind("/"), head.rfind("."))
    if boundary >= limit // 2:
        return head[:boundary].rstrip(" /.") + "…"
    return head.rstrip() + "…"


def _common_dir(paths: List[str]) -> str:
    if not paths:
        return ""
    parts = [p.split("/") for p in paths]
    common: List[str] = []
    for segments in zip(*parts):
        first = segments[0]
        if all(s == first for s in segments):
            common.append(first)
        else:
            break
    if common and common == parts[0][: len(common)] and len(common) == len(parts[0]):
        common = common[:-1]
    return "/".join(common)


def _event_field(event: Any, key: str, default: Any = None) -> Any:
    """Read ``key`` from a dict-like or sqlite3.Row-like ``event``.

    sqlite3.Row supports ``__getitem__`` but not ``.get``; dict supports both.
    Tests pass plain dicts; production passes Rows. Try both safely.
    """
    if event is None:
        return default
    try:
        value = event[key]
    except (KeyError, IndexError, TypeError):
        return default
    return value


def deterministic_message(event: Any, ops: List[Mapping[str, Any]]) -> str:
    """Produce a deterministic commit message from event + ops alone.

    Daemon-adapted: ``tool_name`` is always ``"daemon"`` (the worker reads it
    from a per-event column the daemon does not have). The format mirrors
    snapshot-worker's deterministic output so both lanes produce visually
    consistent commits when AI/command paths are unavailable.
    """
    if not ops:
        subject = "Update files"
        seq = _event_field(event, "seq", 0)
        return f"{subject}\n\n- Snapshot seq: {seq} tool: {DAEMON_TOOL_NAME}"
    if len(ops) == 1:
        op = ops[0]
        kind = op.get("op")
        name = _basename(op.get("path"))
        if kind == "create":
            subject = f"Add {name}"
        elif kind == "modify":
            subject = f"Update {name}"
        elif kind == "delete":
            subject = f"Remove {name}"
        elif kind == "rename":
            subject = f"Rename {_basename(op.get('old_path'))} to {name}"
        else:
            subject = f"Update {name}" if name else "Update files"
    else:
        paths = [str(op.get("path") or "") for op in ops]
        shared = _common_dir(paths)
        if shared:
            subject = f"Update {len(ops)} files in {shared}"
        else:
            subject = f"Update {len(ops)} files"
    subject = _trim_subject(subject)
    lines = [subject, ""]
    for op in ops[:10]:
        kind = op.get("op") or "update"
        if kind == "rename":
            lines.append(f"- Rename {op.get('old_path')} -> {op.get('path')}")
        else:
            lines.append(f"- {str(kind).title()} {op.get('path')}")
    seq = _event_field(event, "seq", 0)
    lines.append(f"- Snapshot seq: {seq} tool: {DAEMON_TOOL_NAME}")
    return "\n".join(lines)


def sanitize_message(text: str) -> str:
    """Normalize an AI/command-produced message into the daemon's format.

    Strips bullet markers from the subject, trims it to 50 chars on a word
    boundary, then re-wraps body bullets at 72 chars with ``- `` prefixes.
    Empty input yields a safe ``"Update files"`` placeholder so callers never
    need to handle ``None`` on top of fallback logic.
    """
    raw = [line.rstrip() for line in text.splitlines()]
    lines = [line for line in raw if line.strip()]
    if not lines:
        return "Update files"
    subject = re.sub(r"^[\-*\s]+", "", lines[0]).strip().rstrip(".")
    subject = _trim_subject(subject) if subject else "Update files"
    body: List[str] = []
    current: Optional[str] = None
    for line in lines[1:]:
        stripped = line.strip()
        if not stripped:
            continue
        if re.match(r"^[\-*]\s+", stripped):
            if current:
                body.append(current)
            current = re.sub(r"^[\-*\s]+", "", stripped).strip()
        else:
            current = f"{current} {stripped}".strip() if current else stripped
    if current:
        body.append(current)
    if not body:
        return subject
    wrapped: List[str] = []
    for bullet in body:
        wrapped.extend(
            textwrap.wrap(
                bullet,
                width=72,
                initial_indent="- ",
                subsequent_indent="  ",
                break_long_words=False,
                break_on_hyphens=False,
            )
        )
    return subject + "\n\n" + "\n".join(wrapped)


def _scrubbed_subprocess_env() -> Dict[str, str]:
    """Return a copy of the daemon env with AI/OpenAI secrets dropped.

    The commit-message subprocess is operator-supplied and may run
    untrusted code; passing it ``OPENAI_API_KEY`` or ``SNAPSHOTD_AI_*``
    settings would let it exfiltrate the daemon's credentials. Strip
    every key whose name starts with ``OPENAI_`` or ``SNAPSHOTD_AI_``.
    """
    env: Dict[str, str] = {}
    for key, value in os.environ.items():
        if key.startswith("OPENAI_"):
            continue
        if key.startswith("SNAPSHOTD_AI_"):
            continue
        env[key] = value
    return env


def ai_message_via_command(
    event: Any,
    ops: List[Mapping[str, Any]],
    diffs: Mapping[int, str],
    repo_root: Optional[Path] = None,
) -> Optional[str]:
    """Run ``SNAPSHOTD_COMMIT_MESSAGE_CMD`` for one event, return sanitized stdout.

    Returns ``None`` (never raises) when the command is unset, fails to
    parse, exits non-zero, or times out, so the caller can fall back to AI
    or deterministic generation. Stdout is fed through ``sanitize_message``
    so the format matches the rest of the pipeline. Sensitive paths are
    redacted in the payload (path/old_path replaced and diff scrubbed)
    before piping to the command. The subprocess inherits a scrubbed env
    so it never sees ``OPENAI_API_KEY`` and friends.
    """
    cmd = _commit_message_cmd()
    if not cmd:
        return None
    try:
        argv = shlex.split(cmd)
    except ValueError:
        return None
    if not argv:
        return None
    op_entries: List[Dict[str, Any]] = []
    safe_paths: List[Optional[str]] = []
    for idx, op in enumerate(ops):
        entry, sensitive = _redacted_op_payload(op, idx, diffs)
        op_entries.append(entry)
        safe_paths.append("<redacted-path>" if sensitive else op.get("path"))
    payload = {
        "seq": _event_field(event, "seq"),
        "branch_ref": _event_field(event, "branch_ref"),
        "tool_name": DAEMON_TOOL_NAME,
        "paths": safe_paths,
        "ops": op_entries,
    }
    try:
        proc = subprocess.run(
            argv,
            input=json.dumps(payload).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=_openai_api_timeout(),
            env=_scrubbed_subprocess_env(),
            cwd=str(repo_root) if repo_root is not None else None,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    text = proc.stdout.decode("utf-8", errors="replace").strip()
    return sanitize_message(text) if text else None


def _build_batch_event_payload(
    event: Any,
    ops: List[Mapping[str, Any]],
    diffs: Mapping[int, str],
) -> Dict[str, Any]:
    """Shape one event for inclusion in a batch request.

    Sensitive ops are redacted in three places: the per-op ``path``
    and ``old_path`` are replaced with ``"<redacted-path>"``, the diff
    body is scrubbed, AND the entry is omitted from the top-level
    ``paths`` array (replaced with the same redacted-path marker so
    the array length still matches ``ops``). This prevents a sensitive
    filename from leaking via the metadata even when the diff itself
    is already scrubbed.

    Daemon-adapted: ``tool_name`` is the literal ``"daemon"``; the daemon's
    capture row has no per-event tool column, so we never leak whatever the
    operator's environment may have set in ``CLAUDE_TOOL_NAME`` or similar.
    """
    op_entries: List[Dict[str, Any]] = []
    safe_paths: List[Optional[str]] = []
    for idx, op in enumerate(ops):
        entry, sensitive = _redacted_op_payload(op, idx, diffs)
        op_entries.append(entry)
        safe_paths.append("<redacted-path>" if sensitive else op.get("path"))
    return {
        "seq": int(_event_field(event, "seq", 0) or 0),
        "tool_name": DAEMON_TOOL_NAME,
        "branch_ref": _event_field(event, "branch_ref", ""),
        "paths": safe_paths,
        "ops": op_entries,
    }


def _is_unsafe_host(host: str) -> bool:
    """Return True if ``host`` resolves to a literal loopback/private/link-local IP.

    DNS-only hostnames are deferred to ``_validate_openai_endpoint``'s
    allowlist gate; this helper only blocks the obvious cases where
    the operator typed a literal address that points back at the host
    or into RFC1918 ranges. We never resolve A/AAAA records ourselves —
    that would race the actual connect — so a hostile DNS server can
    still steer traffic, but the allowlist + HTTPS combination keeps
    the bar high enough.
    """
    host = host.strip().strip("[]").lower()
    if not host:
        return True
    if host in {"localhost", "ip6-localhost", "ip6-loopback"}:
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    if addr.is_loopback or addr.is_private or addr.is_link_local:
        return True
    if addr.is_reserved or addr.is_multicast or addr.is_unspecified:
        return True
    return False


def _allowed_openai_hosts() -> Tuple[str, ...]:
    """Return the active host allowlist.

    Defaults to ``("api.openai.com",)``. Operators add to it via
    ``SNAPSHOTD_AI_ALLOW_HOST`` (comma-separated, additive — the
    default is always included so removing it requires an explicit
    code change).
    """
    extra = os.environ.get("SNAPSHOTD_AI_ALLOW_HOST", "")
    parsed = [h.strip().lower() for h in extra.split(",") if h.strip()]
    return tuple(["api.openai.com", *parsed])


def _validate_openai_endpoint(base_url: str) -> Optional[str]:
    """Validate ``base_url`` and return the endpoint URL or ``None``.

    Enforces: scheme==https, non-empty host, host on the operator
    allowlist (default ``api.openai.com``), and the resolved-literal
    host is not loopback / private / link-local. Returns the full
    chat-completions URL on success.
    """
    try:
        parsed = urllib_parse.urlparse(base_url)
    except (TypeError, ValueError):
        return None
    if parsed.scheme.lower() != "https":
        return None
    host = (parsed.hostname or "").lower()
    if not host:
        return None
    if _is_unsafe_host(host):
        return None
    if host not in _allowed_openai_hosts():
        return None
    return base_url.rstrip("/") + "/chat/completions"


class _NoRedirectHandler(urllib_request.HTTPRedirectHandler):
    """Refuse all redirects on the OpenAI endpoint.

    OpenAI's chat-completions API does not redirect; treating any 3xx
    as an error prevents an attacker on the network path from sending
    a redirect to a host that would happily log the ``Authorization``
    header. urllib's default redirect handler would otherwise replay
    the headers verbatim on the followed request.
    """

    def http_error_301(self, req, fp, code, msg, headers):  # noqa: D401, ARG002
        raise urllib_error.HTTPError(
            req.full_url, code, "redirect refused", headers, fp
        )

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


def _build_openai_opener() -> urllib_request.OpenerDirector:
    """Build an OpenerDirector that refuses redirects.

    Used in place of ``urllib_request.urlopen(req)`` so the
    ``Authorization`` header can never be replayed cross-origin.
    """
    return urllib_request.build_opener(_NoRedirectHandler())


def batch_ai_messages(
    events_with_ops: List[Tuple[Any, List[Mapping[str, Any]]]],
    diffs_by_event: Mapping[int, Mapping[int, str]],
) -> Dict[int, str]:
    """Generate commit messages for many events via OpenAI structured output.

    Chunks events into groups of ``SNAPSHOTD_AI_CHUNK_SIZE``, issues one POST
    to ``{OPENAI_BASE_URL}/chat/completions`` per chunk with a json_schema
    response format, then parses the returned ``messages`` array into a
    ``{seq: "subject\\n\\nbody"}`` mapping (sanitized).

    Returns ``{}`` for any chunk whose request or response fails validation,
    so callers fall back to ``SNAPSHOTD_COMMIT_MESSAGE_CMD`` or
    ``deterministic_message`` for the affected events. The HTTPS-only base
    URL guard prevents diffs from being sent to a plaintext endpoint that
    could be intercepted on a hostile network.
    """
    if not events_with_ops:
        return {}
    api_key = _openai_api_key()
    if not _ai_enable() or not api_key:
        return {}
    endpoint = _validate_openai_endpoint(_openai_base_url())
    if endpoint is None:
        return {}

    opener = _build_openai_opener()
    api_timeout = _openai_api_timeout()
    model = _openai_model()
    out: Dict[int, str] = {}

    chunk_size = max(1, _ai_chunk_size())
    for start in range(0, len(events_with_ops), chunk_size):
        chunk = events_with_ops[start : start + chunk_size]
        chunk_seqs = [int(_event_field(ev, "seq", 0) or 0) for ev, _ops in chunk]
        batch_events: List[Dict[str, Any]] = []
        for event, ops in chunk:
            seq = int(_event_field(event, "seq", 0) or 0)
            diffs = diffs_by_event.get(seq, {})
            batch_events.append(_build_batch_event_payload(event, ops, diffs))

        user_prompt = (
            "Generate commit messages for the following snapshot events.\n"
            "Return one item per event, keyed by its input seq.\n\n"
            f"{json.dumps({'events': batch_events}, ensure_ascii=False)}"
        )
        payload = {
            "model": OPENAI_MODEL,
            "messages": [
                {"role": "system", "content": BATCH_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.3,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "commit_messages",
                    "strict": True,
                    "schema": BATCH_RESPONSE_SCHEMA,
                },
            },
        }
        req = urllib_request.Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {OPENAI_API_KEY}",
            },
            method="POST",
        )
        try:
            with urllib_request.urlopen(req, timeout=OPENAI_API_TIMEOUT) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
        except (urllib_error.URLError, TimeoutError):
            continue
        except Exception:
            continue

        try:
            parsed = json.loads(raw)
            content = parsed["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, json.JSONDecodeError):
            continue

        try:
            structured = json.loads(content)
            items = structured["messages"]
            if not isinstance(items, list):
                raise ValueError("messages is not a list")
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue

        chunk_seq_set = set(chunk_seqs)
        for item in items:
            if not isinstance(item, dict):
                continue
            seq = item.get("seq")
            subject = item.get("subject")
            body = item.get("body")
            if not isinstance(seq, int) or seq not in chunk_seq_set:
                continue
            if not isinstance(subject, str) or not isinstance(body, str):
                continue
            if not subject.strip():
                continue
            composed = (
                subject.strip() + "\n\n" + body.strip()
                if body.strip()
                else subject.strip()
            )
            sanitized = sanitize_message(composed)
            if sanitized:
                out[seq] = sanitized

    return out


def generate_message(
    event: Any,
    ops: List[Mapping[str, Any]],
    diffs: Mapping[int, str],
    *,
    ai_message: Optional[str] = None,
) -> str:
    """Top-level fallback chain: AI -> command -> deterministic.

    ``ai_message`` is a pre-fetched batch result (typically from
    ``batch_ai_messages``); when present and non-empty it wins. Otherwise we
    try the per-event command, falling back to deterministic output. This
    helper itself is pure; callers that want to memoize results into
    ``capture_events.commit_message`` (added by the schema lane) must do so
    explicitly.
    """
    if ai_message:
        stripped = ai_message.strip()
        if stripped:
            return stripped
    if SNAPSHOTD_COMMIT_MESSAGE_CMD:
        try:
            msg = ai_message_via_command(event, ops, diffs)
        except Exception:
            msg = None
        if msg:
            return msg
    return deterministic_message(event, ops)


# --------------------------------------------------------------------------- #
# Replay / publish primitives
# --------------------------------------------------------------------------- #


ABSENT: Tuple[str, str] = ("__absent__", "__absent__")


class GitObjectMissing(RuntimeError):
    """Raised when ``git merge-base --is-ancestor`` cannot resolve an OID.

    Distinct from "the OID is not an ancestor": the latter is a routine
    blocked_conflict, while this represents a corrupt or pruned object
    store and must be surfaced as a real failure mode in ``daemon_meta``.
    """


def _is_ancestor(repo_root: Path, ancestor: str, descendant: str) -> bool:
    """Return True if ``ancestor`` is reachable from ``descendant``.

    git documents two well-defined exit statuses for this command: 0 means
    ancestor, 1 means not-ancestor. Any other status is an actual error
    (typically a missing object, which prints "Not a valid commit name"
    and exits 128). Treating those as "not ancestor" silently masked
    object-store corruption as a generic ``blocked_conflict``; raise
    instead so callers can record the real failure.
    """
    proc = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
    )
    if proc.returncode == 0:
        return True
    if proc.returncode == 1:
        return False
    stderr_text = proc.stderr.decode("utf-8", errors="replace").strip()
    raise GitObjectMissing(
        stderr_text or f"git merge-base --is-ancestor exited {proc.returncode}"
    )


def _validate_op(op: Dict[str, Any]) -> Optional[str]:
    """Reject malformed ops before they touch the index.

    After-fields must be set for any op that writes content. Missing values
    historically fell through to a zero-OID placeholder which corrupted the
    index; refuse them explicitly instead.
    """
    kind = op.get("op")
    path = op.get("path")
    if not path:
        return f"missing path for op {kind!r}"
    if kind in {"create", "modify", "mode", "symlink", "rename"}:
        if not op.get("after_oid"):
            return f"missing after_oid for {kind} {path}"
        if not op.get("after_mode"):
            return f"missing after_mode for {kind} {path}"
    if kind in {"modify", "mode", "symlink", "delete"}:
        if not op.get("before_oid"):
            return f"missing before_oid for {kind} {path}"
        if not op.get("before_mode"):
            return f"missing before_mode for {kind} {path}"
    if kind == "rename":
        if not op.get("old_path"):
            return f"missing old_path for rename {path}"
        if not op.get("before_oid"):
            return f"missing before_oid for rename {path}"
        if not op.get("before_mode"):
            return f"missing before_mode for rename {path}"
    return None


def _verify_op(op: Dict[str, Any], state: Dict[str, Tuple[str, str]]) -> Optional[str]:
    kind = op["op"]
    path = op["path"]
    if kind == "create":
        if path in state and state[path] != (op.get("after_mode"), op.get("after_oid")):
            return f"create conflict for {path}"
        return None
    if kind in {"modify", "mode", "symlink"}:
        before = (op.get("before_mode"), op.get("before_oid"))
        if state.get(path) != before:
            return f"{kind} before-state mismatch for {path}"
        return None
    if kind == "delete":
        before = (op.get("before_mode"), op.get("before_oid"))
        if state.get(path) != before:
            return f"delete before-state mismatch for {path}"
        return None
    if kind == "rename":
        old_path = op.get("old_path") or ""
        before = (op.get("before_mode"), op.get("before_oid"))
        if state.get(old_path) != before:
            return f"rename source mismatch for {old_path}"
        if path in state:
            return f"rename target already exists for {path}"
        return None
    return f"unknown op: {kind}"


def _apply_state(op: Dict[str, Any], state: Dict[str, Tuple[str, str]]) -> None:
    kind = op["op"]
    path = op["path"]
    if kind in {"create", "modify", "mode", "symlink"}:
        state[path] = (op["after_mode"], op["after_oid"])
    elif kind == "delete":
        state.pop(path, None)
    elif kind == "rename":
        old_path = op.get("old_path") or ""
        if old_path:
            state.pop(old_path, None)
        state[path] = (op["after_mode"], op["after_oid"])


def _touched_paths(ops: List[Dict[str, Any]]) -> List[str]:
    paths: List[str] = []
    for op in ops:
        if op.get("old_path"):
            paths.append(str(op["old_path"]))
        paths.append(str(op["path"]))
    return sorted(set(paths))


def _live_index_entries(repo_root: Path, paths: List[str]) -> Dict[str, Tuple[str, str]]:
    if not paths:
        return {}
    proc = subprocess.run(
        ["git", "ls-files", "-s", "-z", "--", *paths],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
    )
    if proc.returncode != 0:
        return {}
    entries: Dict[str, Tuple[str, str]] = {}
    for chunk in proc.stdout.split(b"\x00"):
        if not chunk:
            continue
        meta, _tab, path_bytes = chunk.partition(b"\t")
        parts = meta.split()
        if len(parts) >= 2:
            entries[os.fsdecode(path_bytes)] = (parts[0].decode(), parts[1].decode())
    return entries


def _tree_entries(repo_root: Path, rev: str, paths: List[str]) -> Dict[str, Tuple[str, str]]:
    if not paths:
        return {}
    proc = subprocess.run(
        ["git", "ls-tree", "-z", rev, "--", *paths],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
    )
    if proc.returncode != 0:
        return {}
    entries: Dict[str, Tuple[str, str]] = {}
    for chunk in proc.stdout.split(b"\x00"):
        if not chunk:
            continue
        meta, _tab, path_bytes = chunk.partition(b"\t")
        parts = meta.split()
        if len(parts) >= 3:
            entries[os.fsdecode(path_bytes)] = (parts[0].decode(), parts[2].decode())
    return entries


def _entry(state: Dict[str, Tuple[str, str]], path: str) -> Tuple[str, str]:
    return state.get(path) or ABSENT


def _reconcile_live_index(
    repo_root: Path,
    paths: List[str],
    pre_state: Dict[str, Tuple[str, str]],
    post_state: Dict[str, Tuple[str, str]],
    captured_index: Optional[Dict[str, Tuple[str, str]]] = None,
    conn: Any = None,
) -> None:
    live = _live_index_entries(repo_root, paths)
    safe: List[str] = []
    for path in paths:
        live_entry = live.get(path) or ABSENT
        pre_entry = _entry(pre_state, path)
        post_entry = _entry(post_state, path)
        if live_entry == post_entry:
            continue
        if captured_index is not None:
            # Tighter predicate: only reset when live still matches the index
            # snapshot captured before the publish critical section AND that
            # snapshot matched our pre-state expectation. Guards against races
            # where a concurrent writer mutated the index mid-publish.
            captured_entry = captured_index.get(path) or ABSENT
            if live_entry == captured_entry and captured_entry == pre_entry:
                safe.append(path)
        elif live_entry == pre_entry:
            safe.append(path)
    if not safe:
        return
    proc = subprocess.run(
        ["git", "reset", "-q", "--", *safe],
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_git_env(),
        check=False,
    )
    if proc.returncode != 0 and conn is not None:
        stderr_text = proc.stderr.decode("utf-8", errors="replace").strip()
        try:
            set_daemon_meta(conn, "last_reconcile_error", stderr_text or f"git reset exited {proc.returncode}")
        except Exception:
            pass


def recover_publishing(conn, repo_root: Path, ctx: Dict[str, Any]) -> None:
    """Reconcile a crash between commit creation, update-ref, and DB settlement.

    ``publish_state`` stores the one event that was in the publish critical
    section. If the target commit is now reachable from the branch, the publish
    completed and the row can be marked ``published``. If the ref never moved
    and still equals ``source_head``, the event can safely become ``pending``
    again. Anything else is a conflict, not an opportunity to replay blindly.
    """
    row = conn.execute("SELECT * FROM publish_state WHERE id=1").fetchone()
    if row is None or row["status"] != "publishing" or row["event_seq"] is None:
        return

    event_seq = int(row["event_seq"])
    branch = str(row["branch_ref"] or "")
    target = str(row["target_commit_oid"] or "")
    source_head = str(row["source_head"] or "")
    expected_generation = int(row["branch_generation"] or 0)
    live_branch = str(ctx["branch_ref"])
    live_generation = int(ctx["branch_generation"])
    live_head = str(ctx["base_head"])

    target_reachable = False
    object_missing_exc: Optional[GitObjectMissing] = None
    reason: Optional[str] = None
    if branch != live_branch or expected_generation != live_generation:
        reason = "stale branch during publish recovery"
    elif target:
        try:
            target_reachable = _is_ancestor(repo_root, target, live_head)
        except GitObjectMissing as exc:
            # Defer the "real error" decision: if the ref never moved
            # (live_head == source_head), the target was a placeholder
            # for a commit that was never created, and the rollback path
            # below is the correct outcome. Only surface object_missing
            # as a hard failure when we cannot rollback either.
            object_missing_exc = exc
            try:
                set_daemon_meta(conn, "last_replay_object_missing", f"recover:{exc}")
            except Exception:
                pass

    if target_reachable:
        ops = [dict(op) for op in load_ops(conn, event_seq)]
        paths = _touched_paths(ops)
        _reconcile_live_index(
            repo_root,
            paths,
            _tree_entries(repo_root, source_head, paths),
            _tree_entries(repo_root, target, paths),
            conn=conn,
        )
        # Route through mark_event_published so published_ts is set
        # consistently — without it, recovered events were eligible for
        # retention pruning the moment the next sweep ran.
        mark_event_published(conn, seq=event_seq, commit_oid=target)
        update_publish_state(
            conn,
            event_seq=event_seq,
            branch_ref=live_branch,
            branch_generation=live_generation,
            source_head=source_head,
            target_commit_oid=target,
            status="published",
        )
        return

    if reason is None and live_head == source_head:
        conn.execute(
            "UPDATE capture_events SET state='pending', commit_oid=NULL, error=NULL WHERE seq=?",
            (event_seq,),
        )
        update_publish_state(
            conn,
            event_seq=None,
            branch_ref=live_branch,
            branch_generation=live_generation,
            source_head=live_head,
            target_commit_oid=None,
            status="idle",
        )
        return

    if reason is None:
        if object_missing_exc is not None:
            # The ref moved AND the recorded target cannot be resolved —
            # the queue is genuinely corrupt, not just rolled back.
            reason = f"object_missing during publish recovery: {object_missing_exc}"
        else:
            reason = "branch moved during publish recovery"

    conn.execute(
        "UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?",
        (reason, event_seq),
    )
    update_publish_state(
        conn,
        event_seq=event_seq,
        branch_ref=live_branch,
        branch_generation=live_generation,
        source_head=live_head,
        target_commit_oid=target or None,
        status="blocked_conflict",
        error=reason,
    )


def replay_pending_events(
    conn,
    repo_root: Path,
    git_dir: Path,
    *,
    lock_timeout: Optional[float] = None,
    batch_max: Optional[int] = None,
) -> int:
    """Drain pending events into commits, bounded by ``lock_timeout`` seconds.

    A blocked ``publish_lock`` is the most likely cause of the daemon's ack
    loop stalling forever, so we use a timeout by default and surface
    ``PublishLockBusy`` to the caller. The caller (the daemon main loop)
    records the error in ``daemon_meta.last_publish_error`` and acks queued
    flush rows with the failure note rather than leaving controllers hung.

    The drain is split into batches of at most ``batch_max`` events
    (``SNAPSHOTD_REPLAY_BATCH_MAX`` env var, default 200). Between
    batches we release ``publish_lock`` so sibling tools and the
    daemon's flush ackers get a turn. ``daemon_meta.last_replay_deferred``
    is updated with the still-queued count after each batch (0 when the
    lane drains).
    """
    timeout = REPLAY_PUBLISH_LOCK_TIMEOUT if lock_timeout is None else lock_timeout
    limit = batch_max if batch_max is not None else _replay_batch_max()
    if limit <= 0:
        limit = _replay_batch_max()
    total = 0
    while True:
        with publish_lock(git_dir, timeout=timeout):
            published, processed, remaining, terminated = _replay_pending_events_locked(
                conn, repo_root, git_dir, batch_limit=limit
            )
        total += published
        try:
            set_daemon_meta(conn, "last_replay_deferred", str(remaining))
        except Exception:
            pass
        # Stop when the lane drained, when the batch terminated early
        # because of a downstream-poisoning failure, or when nothing was
        # processable. Otherwise the lock has been released and the next
        # iteration re-acquires it, giving sibling tools a turn.
        if remaining == 0 or processed == 0 or terminated:
            return total


def _replay_pending_events_locked(
    conn, repo_root: Path, git_dir: Path, *, batch_limit: Optional[int] = None
) -> Tuple[int, int, int, bool]:
    """Process up to ``batch_limit`` pending events under publish_lock.

    Returns ``(published, processed, remaining, terminated)``:
      - ``published``: events that resulted in a new commit
      - ``processed``: rows touched (published + skipped/failed) — 0 means
        the caller should not loop, since nothing changed.
      - ``remaining``: pending events still queued after this batch.
      - ``terminated``: True when the batch broke early because of a
        downstream-poisoning failure (commit-tree / update-ref). The
        caller must not re-enter, since later pending events depend on
        this event's after-state and the next replay cycle has to
        rebuild the index from the live HEAD first.
    """
    ctx = repo_context(repo_root, git_dir)
    branch = ctx["branch_ref"]
    head = ctx["base_head"]
    recover_publishing(conn, repo_root, ctx)
    pending = load_pending_events(conn, branch)
    if not pending:
        return 0, 0, 0, False
    total_pending = len(pending)
    if batch_limit is not None and batch_limit > 0:
        pending = pending[:batch_limit]

    # ----- AI / command pre-pass --------------------------------------- #
    # Decide whether either of the message-generation paths needs op diffs.
    # When neither is enabled the default-deterministic path must remain
    # byte-identical to the historical ``build_message`` output, and we
    # must NOT pay the cost of computing diffs.
    use_batch_ai = (
        SNAPSHOTD_AI_ENABLE
        and bool(OPENAI_API_KEY)
        and len(pending) <= SNAPSHOTD_AI_MAX_QUEUE_DEPTH
    )
    use_command_msg = bool(SNAPSHOTD_COMMIT_MESSAGE_CMD)
    need_diffs = use_batch_ai or use_command_msg

    # Pre-load ops once per event so the commit loop and the diff pre-pass
    # share the same data. Existing per-event ops loads inside the loop are
    # replaced by lookups into this map.
    ops_by_seq: Dict[int, List[Dict[str, Any]]] = {}
    for event in pending:
        ops_by_seq[int(event["seq"])] = [
            dict(row) for row in load_ops(conn, int(event["seq"]))
        ]

    diffs_by_event: Dict[int, Dict[int, str]] = {}
    if need_diffs:
        for event in pending:
            seq = int(event["seq"])
            # Skip diff computation for events that already have a stored
            # message — the chain will pick that up directly without
            # consulting AI/command.
            existing = _event_field(event, "message")
            if existing:
                continue
            diffs_by_event[seq] = compute_diffs_for_event(repo_root, ops_by_seq[seq])

    if use_batch_ai:
        events_needing_msg: List[Tuple[Any, List[Mapping[str, Any]]]] = [
            (event, ops_by_seq[int(event["seq"])])
            for event in pending
            if not _event_field(event, "message")
        ]
        generated: Dict[int, str] = {}
        if events_needing_msg:
            try:
                generated = batch_ai_messages(events_needing_msg, diffs_by_event)
            except Exception:
                generated = {}
        if generated:
            try:
                with transaction(conn):
                    for seq, message in generated.items():
                        set_event_message(conn, int(seq), message)
            except Exception:
                # Persistence failure is never fatal — the same messages are
                # still available in-memory below via ``generated``, and the
                # next replay cycle can re-derive any that are missing.
                pass
        # Reflect newly-stored messages into the in-memory rows so the
        # commit loop's ``event["message"]`` lookup sees them without a
        # second SELECT.
        if generated:
            refreshed: List[Any] = []
            for event in pending:
                seq = int(event["seq"])
                stored = _event_field(event, "message")
                if not stored and seq in generated:
                    refreshed.append({**dict(event), "message": generated[seq]})
                else:
                    refreshed.append(event)
            pending = refreshed

    env = _clean_git_env({"GIT_INDEX_FILE": str(index_path(git_dir))})

    try:
        index_file = index_path(git_dir)
        index_file.parent.mkdir(parents=True, exist_ok=True)
        index_file.unlink(missing_ok=True)
        proc = subprocess.run(
            ["git", "read-tree", head],
            cwd=str(repo_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", errors="replace").strip())
        state = dict(snapshot_state_for_index(repo_root, env))
        parent = head
        published = 0
        processed = 0
        terminated = False

        for event in pending:
            ops = ops_by_seq.get(int(_event_field(event, "seq", 0) or 0)) or [
                dict(row) for row in load_ops(conn, int(event["seq"]))
            ]
            if int(event["branch_generation"]) != int(ctx["branch_generation"]):
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="blocked_conflict",
                    error="stale branch generation",
                )
                conn.execute("UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?", ("stale branch generation", int(event["seq"])))
                processed += 1
                continue
            try:
                ancestor_ok = _is_ancestor(repo_root, str(event["base_head"]), head)
            except GitObjectMissing as exc:
                # The captured ``base_head`` cannot be resolved — typically
                # because the object store was pruned/corrupted. Surface
                # the real failure instead of papering over it as a
                # generic "stale branch ancestry" blocked_conflict.
                err_text = f"object_missing: {exc}"
                try:
                    set_daemon_meta(
                        conn,
                        "last_replay_object_missing",
                        f"seq={int(event['seq'])}: {exc}",
                    )
                except Exception:
                    pass
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="failed",
                    error=err_text,
                )
                conn.execute(
                    "UPDATE capture_events SET state='failed', error=? WHERE seq=?",
                    (err_text, int(event["seq"])),
                )
                processed += 1
                continue
            if not ancestor_ok:
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="blocked_conflict",
                    error="stale branch ancestry",
                )
                conn.execute(
                    "UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?",
                    ("stale branch ancestry", int(event["seq"])),
                )
                processed += 1
                continue
            validation_error = None
            for op in ops:
                validation_error = _validate_op(op)
                if validation_error:
                    break
            if validation_error:
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="failed",
                    error=validation_error,
                )
                conn.execute("UPDATE capture_events SET state='failed', error=? WHERE seq=?", (validation_error, int(event["seq"])))
                processed += 1
                continue

            reason = None
            for op in ops:
                reason = _verify_op(op, state)
                if reason:
                    break
            if reason:
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=head,
                    target_commit_oid=None,
                    status="blocked_conflict",
                    error=reason,
                )
                conn.execute("UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?", (reason, int(event["seq"])))
                processed += 1
                continue

            saved = dict(state)
            touched = _touched_paths(ops)
            captured_index = _live_index_entries(repo_root, touched)
            for op in ops:
                _apply_state(op, state)
            # Capture the per-event expected parent BEFORE entering the
            # publish critical section. ``recover_publishing`` will compare
            # this to the live ref tip after a crash; the previous code
            # always wrote ``head`` (the head at start-of-batch), which
            # turned every post-first-event crash into a `blocked_conflict`
            # for valid downstream events.
            event_parent = parent
            try:
                apply_ops_to_index(repo_root, env, ops)
                tree_proc = subprocess.run(
                    ["git", "write-tree"],
                    cwd=str(repo_root),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
                if tree_proc.returncode != 0:
                    raise RuntimeError(
                        tree_proc.stderr.decode("utf-8", errors="replace").strip()
                    )
                tree = tree_proc.stdout.decode("utf-8", errors="replace").strip()
                # Fallback chain: stored AI batch message → command output →
                # deterministic. AI/command failures NEVER mark the event
                # failed — they silently fall through. With AI off and no
                # command set, we route to ``build_message`` (the existing
                # deterministic helper) so the default replay path stays
                # byte-identical to the pre-integration behavior.
                stored_message = _event_field(event, "message")
                if stored_message and str(stored_message).strip():
                    message = str(stored_message).strip()
                elif use_command_msg:
                    diffs = diffs_by_event.get(int(event["seq"]), {})
                    try:
                        cmd_msg = ai_message_via_command(event, ops, diffs)
                    except Exception:
                        cmd_msg = None
                    message = cmd_msg if cmd_msg else build_message(event, ops)
                else:
                    message = build_message(event, ops)
                commit_proc = subprocess.run(
                    ["git", "commit-tree", tree, "-p", event_parent],
                    cwd=str(repo_root),
                    input=message.encode("utf-8"),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
                if commit_proc.returncode != 0:
                    raise RuntimeError(
                        commit_proc.stderr.decode("utf-8", errors="replace").strip()
                    )
                commit_oid = commit_proc.stdout.decode("utf-8", errors="replace").strip()
            except Exception as exc:
                # Terminal failure (validation/commit-tree). Mark this
                # event ``failed`` and stop the batch: downstream events
                # depend on the failed event's after-state, so continuing
                # would chain `before-state mismatch` errors. The next
                # replay cycle will rebuild the index from the live HEAD
                # and re-attempt any still-pending events.
                state = saved
                _read_tree_safely(repo_root, env, event_parent, conn)
                conn.execute(
                    "UPDATE capture_events SET state='failed', error=? WHERE seq=?",
                    (str(exc), int(event["seq"])),
                )
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=event_parent,
                    target_commit_oid=None,
                    status="failed",
                    error=str(exc),
                )
                processed += 1
                terminated = True
                break

            update_publish_state(
                conn,
                event_seq=int(event["seq"]),
                branch_ref=branch,
                branch_generation=int(ctx["branch_generation"]),
                source_head=event_parent,
                target_commit_oid=commit_oid,
                status="publishing",
            )
            conn.execute("UPDATE capture_events SET state='publishing' WHERE seq=?", (int(event["seq"]),))

            try:
                proc = subprocess.run(
                    ["git", "update-ref", branch, commit_oid, event_parent],
                    cwd=str(repo_root),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
                if proc.returncode != 0:
                    raise RuntimeError(
                        proc.stderr.decode("utf-8", errors="replace").strip()
                    )
            except Exception as exc:
                # update-ref failed (typically because a concurrent push
                # moved the ref). Mark this event ``blocked_conflict`` and
                # stop the batch — the conflict has to be resolved against
                # the new branch tip before any later event can land.
                state = saved
                _read_tree_safely(repo_root, env, event_parent, conn)
                conn.execute(
                    "UPDATE capture_events SET state='blocked_conflict', error=? WHERE seq=?",
                    (str(exc), int(event["seq"])),
                )
                update_publish_state(
                    conn,
                    event_seq=int(event["seq"]),
                    branch_ref=branch,
                    branch_generation=int(ctx["branch_generation"]),
                    source_head=event_parent,
                    target_commit_oid=commit_oid,
                    status="blocked_conflict",
                    error=str(exc),
                )
                processed += 1
                terminated = True
                break

            parent = commit_oid
            published += 1
            processed += 1
            mark_event_published(conn, seq=int(event["seq"]), commit_oid=commit_oid)
            _reconcile_live_index(
                repo_root,
                touched,
                saved,
                state,
                captured_index=captured_index,
                conn=conn,
            )
            update_publish_state(
                conn,
                event_seq=int(event["seq"]),
                branch_ref=branch,
                branch_generation=int(ctx["branch_generation"]),
                source_head=event_parent,
                target_commit_oid=commit_oid,
                status="published",
            )

        # Remaining = total pending at start - rows we touched in this
        # batch. Even when ``processed < batch_size`` (an early ``break``
        # hit a fail/conflict), we still report the still-queued tail so
        # the outer loop can surface ``deferred=N`` accurately.
        remaining = max(0, total_pending - processed)
        return published, processed, remaining, terminated
    finally:
        try:
            index_path(git_dir).unlink(missing_ok=True)
        except OSError:
            pass


def _read_tree_safely(repo_root: Path, env: Dict[str, str], rev: str, conn: Any) -> None:
    """Roll the in-memory index back to ``rev``; record failures via daemon_meta."""
    proc = subprocess.run(
        ["git", "read-tree", rev],
        cwd=str(repo_root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0 and conn is not None:
        try:
            set_daemon_meta(
                conn,
                "last_replay_rollback_error",
                proc.stderr.decode("utf-8", errors="replace").strip()
                or f"git read-tree exited {proc.returncode}",
            )
        except Exception:
            pass


def cmd_status(repo_root: Path, git_dir: Path) -> int:
    conn = ensure_state(git_dir)
    try:
        payload = status_snapshot(conn, git_dir)
        payload["repo_root"] = str(repo_root)
        payload["git_dir"] = str(git_dir)
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    finally:
        conn.close()


def cmd_flush(repo_root: Path, git_dir: Path) -> int:
    conn = ensure_state(git_dir)
    try:
        published = replay_pending_events(conn, repo_root, git_dir)
        print(f"published={published}")
        return 0
    finally:
        conn.close()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Replay daemon snapshot events")
    parser.add_argument("--repo", default=os.getcwd(), help="repo working directory")
    parser.add_argument("--git-dir", help="explicit git dir override")
    parser.add_argument("--status", action="store_true", help="print queue status")
    parser.add_argument("--flush", action="store_true", help="drain pending events")
    args = parser.parse_args(argv)

    repo_input = Path(args.repo).expanduser()
    try:
        repo_root, git_dir, _common = resolve_repo_paths(repo_input)
        if args.git_dir:
            git_dir = Path(args.git_dir).expanduser().resolve()
    except Exception as exc:
        print(f"not a git repository: {exc}", file=sys.stderr)
        return 1

    if args.status:
        return cmd_status(repo_root, git_dir)
    if args.flush:
        return cmd_flush(repo_root, git_dir)
    return cmd_status(repo_root, git_dir)


if __name__ == "__main__":
    sys.exit(main())

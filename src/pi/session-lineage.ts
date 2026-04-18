/**
 * Session lineage helper for the PI adapter.
 *
 * PI exposes a `ReadonlySessionManager` with `getHeader()` that returns the
 * header for the current session. The header carries `parentSession` which is
 * the path to the parent session's file (not a session id). Because the core
 * `HostAdapter` only asks for the root session id reachable from a starting
 * id, we walk best-effort: when the current request matches the session
 * manager's current session we return its ultimate parent-less ancestor's id
 * (falling back to the current id when the lineage chain cannot be resolved).
 *
 * This is intentionally conservative. PI's read-only API does not expose a
 * way to look up arbitrary session headers by id, so for any sessionId that
 * isn't the currently-active one we return the input id unchanged. That keeps
 * the `runIn: "main"` semantics sane: the current session resolves to its
 * root, everything else resolves to itself.
 */

import type { ExtensionContext, SessionHeader } from "@mariozechner/pi-coding-agent";
import { closeSync, openSync, readSync } from "node:fs";

// P2 #19: bound the lineage walk + per-file read so a pathological session
// chain or oversized session header line cannot block the event loop.
const MAX_LINEAGE_DEPTH = 64;
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * ReadonlySessionManager is exposed via ExtensionContext.sessionManager but
 * is not re-exported as a named type from the package root. Derive it.
 */
type ReadonlySessionManager = ExtensionContext["sessionManager"];

/**
 * Return the root session id reachable from `currentSessionId`.
 *
 * Walks `sessionManager.getHeader().parentSession` when it points to a file
 * path we can read; otherwise returns the starting id. Best-effort by design.
 */
export function getRootSessionId(
  currentSessionId: string,
  sessionManager: ReadonlySessionManager | undefined,
): string {
  if (!currentSessionId) return currentSessionId;
  if (!sessionManager) return currentSessionId;

  let header: SessionHeader | null = null;
  try {
    header = sessionManager.getHeader();
  } catch {
    return currentSessionId;
  }
  if (!header) return currentSessionId;

  // If the caller is asking about a session that isn't the session manager's
  // current one, we can't resolve lineage without loading arbitrary session
  // files. Return the input unchanged.
  if (header.id !== currentSessionId) return currentSessionId;

  // Walk up via parentSession file paths. We read just the header prefix of
  // each parent file (capped at MAX_HEADER_BYTES) to pick up the
  // id/parentSession for the next hop.
  const visited = new Set<string>([header.id]);
  let cursor: SessionHeader | null = header;
  let depth = 0;
  while (cursor?.parentSession) {
    if (++depth > MAX_LINEAGE_DEPTH) break;
    const parent = readSessionHeaderFromFile(cursor.parentSession);
    if (!parent) break;
    if (visited.has(parent.id)) break;
    visited.add(parent.id);
    cursor = parent;
  }

  return cursor?.id ?? currentSessionId;
}

function readSessionHeaderFromFile(filePath: string): SessionHeader | null {
  // Read at most MAX_HEADER_BYTES from the start of the file. This is
  // enough to recover the JSON header line on any sane session file and
  // bounded if a file is unexpectedly huge.
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES);
    const read = readSync(fd, buffer, 0, MAX_HEADER_BYTES, 0);
    const text = buffer.toString("utf8", 0, read);
    const newlineIndex = text.indexOf("\n");
    const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
    if (!firstLine.trim()) return null;
    const parsed = JSON.parse(firstLine) as { type?: string; id?: string; parentSession?: string; timestamp?: string; cwd?: string };
    if (parsed?.type !== "session" || typeof parsed.id !== "string") return null;
    return {
      type: "session",
      id: parsed.id,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      ...(typeof parsed.parentSession === "string" ? { parentSession: parsed.parentSession } : {}),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

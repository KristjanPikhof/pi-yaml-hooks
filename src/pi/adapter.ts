/**
 * Phase-1 PI adapter for atomic-commit-snapshot.
 *
 * Registers the minimum set of PI event handlers that pipe built-in `write`
 * and `edit` tool results into the Python snapshot-hook, and flushes the
 * snapshot worker on graceful session exits / switches.
 *
 * NOTE: This is the Phase-1 minimal adapter. A later lane (adapter-lane)
 * will expand this to cover bash inference, multi-file edits, and the
 * full hook dispatch surface.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runPythonSnapshotHook, runSnapshotWorkerFlush } from "./python-bridge.js";
import { synthesizeFileChangedFromToolResult } from "./synthesize-file-changed.js";

/**
 * Register the Phase-1 snapshot handlers on the given PI extension API.
 *
 * Windows guardrail: the Python snapshot worker stack relies on POSIX
 * signals (SIGUSR1) and POSIX process groups. On win32 we log one warning
 * and register nothing.
 */
export function registerPhase1Adapter(pi: ExtensionAPI): void {
  if (process.platform === "win32") {
    // eslint-disable-next-line no-console
    console.warn(
      "[pi-hooks] atomic-commit-snapshot is not supported on Windows; extension is a no-op.",
    );
    return;
  }

  pi.on("tool_result", async (event, ctx) => {
    const sessionId = safeGetSessionId(ctx);
    const payload = synthesizeFileChangedFromToolResult(event, {
      cwd: ctx.cwd,
      sessionId,
    });
    if (!payload) return;

    try {
      const result = await runPythonSnapshotHook(payload, { cwd: ctx.cwd });
      if (result.exitCode !== 0) {
        debugLog(
          `snapshot-hook exited ${result.exitCode}` +
            (result.stderr ? `: ${truncate(result.stderr)}` : ""),
        );
      }
    } catch (error) {
      debugLog(
        `snapshot-hook spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await flushQuietly(ctx.cwd);
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    await flushQuietly(ctx.cwd);
    // No cancellation — we just drain the queue; return nothing so PI proceeds.
  });
}

async function flushQuietly(cwd: string): Promise<void> {
  try {
    const result = await runSnapshotWorkerFlush(cwd);
    if (result.exitCode !== 0) {
      debugLog(
        `snapshot-worker --flush exited ${result.exitCode}` +
          (result.stderr ? `: ${truncate(result.stderr)}` : ""),
      );
    }
  } catch (error) {
    debugLog(
      `snapshot-worker --flush spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function safeGetSessionId(ctx: { sessionManager?: { getSessionId?: () => string } }): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function debugLog(message: string): void {
  if (process.env.PI_HOOKS_DEBUG) {
    // eslint-disable-next-line no-console
    console.warn(`[pi-hooks] ${message}`);
  }
}

function truncate(value: string, max = 400): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

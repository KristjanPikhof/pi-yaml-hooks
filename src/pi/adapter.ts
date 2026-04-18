/**
 * PI adapter for pi-hooks.
 *
 * Loads hooks.yaml via `core/load-hooks.ts`, constructs the core runtime via
 * `createHooksRuntime`, and forwards every relevant PI event into the
 * runtime's `tool.execute.before` / `tool.execute.after` / `event` dispatch
 * surface.
 *
 * file.changed is synthesized from `tool_result` events for the PI built-in
 * `write` and `edit` tools so that YAML-defined `file.changed` hooks fire on
 * file mutations.
 *
 * Windows guardrail: the bash executor depends on a POSIX bash on PATH. On
 * win32 we emit one warning and register nothing.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";

/**
 * Aliased locally: ReadonlySessionManager is defined in the PI package but
 * not re-exported from its root module. We recover it from ExtensionContext
 * so we don't reach into a subpath export.
 */
type ReadonlySessionManager = ExtensionContext["sessionManager"];

import { executeBashHook } from "../core/bash-executor.js";
import type { BashExecutionRequest, BashHookResult } from "../core/bash-types.js";
import { loadDiscoveredHooks } from "../core/load-hooks.js";
import {
  createHooksRuntime,
  type HooksRuntime,
  type ToolExecuteAfterInput,
  type ToolExecuteBeforeInput,
  type ToolExecuteBeforeOutput,
} from "../core/runtime.js";
import type { HookNotifyLevel, HostAdapter } from "../core/types.js";
import { getRootSessionId } from "./session-lineage.js";

/**
 * Register the PI adapter on the given extension API.
 *
 * Installs:
 * - `tool_call`    → runtime `tool.execute.before` (+ block-tool response)
 * - `tool_result`  → Phase 1 snapshot-hook + runtime `tool.execute.after`
 * - `agent_end`    → runtime `session.idle` (when idle + no pending messages)
 * - `session_start`→ runtime `session.created` (on new/startup)
 * - `session_shutdown` / `session_before_switch`
 *                  → Phase 1 worker flush + runtime `session.deleted`
 *                    (lossy compat shim: PI emits these on /new, /resume,
 *                    /fork too — we can't distinguish, so we fire
 *                    session.deleted for all of them)
 */
export function registerAdapter(pi: ExtensionAPI): void {
  if (process.platform === "win32") {
    // eslint-disable-next-line no-console
    console.warn(
      "[pi-hooks] bash hooks require a POSIX bash on PATH; Windows is unsupported. Extension is a no-op.",
    );
    return;
  }

  // Runtime is created lazily on the first event so that `ctx.cwd` is
  // available and we honour the project's hooks.yaml location. Once built,
  // we cache the runtime keyed by cwd so subsequent cwd changes in the same
  // process (should PI ever support that) pick up the right project config.
  const runtimes = new Map<string, HooksRuntime>();
  const callIdsToSessionIds = new Map<string, string>();
  // Track the most recently observed ExtensionContext per cwd so that the
  // HostAdapter UI methods (notify/confirm/setStatus) can reach ctx.ui even
  // though they live outside the event handler scope. The ctx is replayed
  // for each PI event, so "last seen" is the right handle to use.
  const latestContexts = new Map<string, ExtensionContext>();

  function rememberContext(cwd: string, ctx: ExtensionContext): void {
    latestContexts.set(cwd, ctx);
  }

  function getRuntimeFor(cwd: string, sessionManager: ReadonlySessionManager | undefined): HooksRuntime {
    const existing = runtimes.get(cwd);
    if (existing) return existing;

    const host = createHostAdapter(pi, cwd, sessionManager, () => latestContexts.get(cwd));
    const loaded = loadDiscoveredHooks({ projectDir: cwd });
    if (loaded.errors.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[pi-hooks] Failed to load some hooks; continuing with valid hooks:\n${loaded.errors
          .map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
          .join("\n")}`,
      );
    }
    const runtime = createHooksRuntime(host, { directory: cwd, hooks: loaded.hooks });
    runtimes.set(cwd, runtime);
    return runtime;
  }

  // ---- tool_call ----
  // PI's tool_call handler may return { block: true, reason } to stop
  // execution before the tool runs (see dist/core/extensions/types.d.ts:
  // ToolCallEventResult). The core runtime throws on block; we translate.
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;

    const runtime = getRuntimeFor(ctx.cwd, ctx.sessionManager);
    callIdsToSessionIds.set(event.toolCallId, sessionId);

    const input: ToolExecuteBeforeInput = {
      tool: event.toolName,
      sessionID: sessionId,
      callID: event.toolCallId,
    };
    const output: ToolExecuteBeforeOutput = {
      args: (event.input ?? {}) as Record<string, unknown>,
    };

    try {
      await runtime["tool.execute.before"](input, output);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debugLog(`tool.execute.before blocked ${event.toolName}: ${reason}`);
      // The runtime calls host.abort() internally when a `stop` behaviour hook
      // fires; we also report the block back to PI so the tool doesn't run.
      return { block: true, reason };
    }
  });

  // ---- tool_result ----
  // Dispatch tool.after.* through the core runtime. The runtime emits
  // file.changed for mutation tools (write/edit) internally — see
  // src/core/runtime.ts:282 — so YAML file.changed hooks fire from this path.
  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager) ?? callIdsToSessionIds.get(event.toolCallId);

    if (sessionId) {
      try {
        const runtime = getRuntimeFor(ctx.cwd, ctx.sessionManager);
        const input: ToolExecuteAfterInput = {
          tool: event.toolName,
          sessionID: sessionId,
          callID: event.toolCallId,
          args: (event.input ?? {}) as Record<string, unknown>,
        };
        await runtime["tool.execute.after"](input);
      } catch (error) {
        debugLog(
          `tool.execute.after dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        callIdsToSessionIds.delete(event.toolCallId);
      }
    } else {
      callIdsToSessionIds.delete(event.toolCallId);
    }
  });

  // ---- agent_end ----
  // Fire session.idle once the agent loop ends AND no messages are queued.
  pi.on("agent_end", async (_event, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;
    if (!ctx.isIdle || !ctx.isIdle()) return;
    if (ctx.hasPendingMessages && ctx.hasPendingMessages()) return;

    try {
      const runtime = getRuntimeFor(ctx.cwd, ctx.sessionManager);
      await runtime.event({
        event: { type: "session.idle", properties: { sessionID: sessionId } },
      });
    } catch (error) {
      debugLog(
        `session.idle dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // ---- session_start ----
  // Filter to genuine session creation (new/startup). resume/reload/fork are
  // existing sessions being re-entered; firing session.created there would
  // overfire hooks that are meant to run once per fresh session.
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    if (event.reason !== "new" && event.reason !== "startup") return;
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;

    try {
      const runtime = getRuntimeFor(ctx.cwd, ctx.sessionManager);
      await runtime.event({
        event: {
          type: "session.created",
          properties: { info: { id: sessionId } },
        },
      });
    } catch (error) {
      debugLog(
        `session.created dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // ---- session_shutdown ----
  // Fire session.deleted (lossy compat shim: PI does not distinguish graceful
  // shutdown from /new|/resume|/fork and session_shutdown also fires on
  // terminal exit; the runtime re-entry after the process dies is harmless).
  pi.on("session_shutdown", async (_event, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;

    try {
      const runtime = getRuntimeFor(ctx.cwd, ctx.sessionManager);
      await runtime.event({
        event: {
          type: "session.deleted",
          properties: { info: { id: sessionId } },
        },
      });
    } catch (error) {
      debugLog(
        `session.deleted dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // ---- session_before_switch ----
  // Same lossy compat shim as session_shutdown: fires on /new, /resume,
  // /fork with no clean way to distinguish. Fire session.deleted so per-session
  // cleanup hooks run before the switch.
  pi.on("session_before_switch", async (_event, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;

    try {
      const runtime = getRuntimeFor(ctx.cwd, ctx.sessionManager);
      await runtime.event({
        event: {
          type: "session.deleted",
          properties: { info: { id: sessionId } },
        },
      });
    } catch (error) {
      debugLog(
        `session.deleted (before_switch) dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

/** Backwards-compat alias for the Phase 1 export name. */
export const registerPhase1Adapter = registerAdapter;

function createHostAdapter(
  pi: ExtensionAPI,
  projectDir: string,
  sessionManager: ReadonlySessionManager | undefined,
  getContext: () => ExtensionContext | undefined,
): HostAdapter {
  // Once-per-missing-capability warning flags. We log a single warning per
  // process lifetime instead of spamming on every hook invocation when the
  // host's UI surface is absent (e.g. print/RPC mode where ctx.hasUI is
  // false, or ctx not yet captured before the first event).
  let warnedNoNotify = false;
  let warnedNoConfirm = false;
  let warnedNoSetStatus = false;

  return {
    // PI only exposes abort on the current ExtensionContext; we do not have
    // a cross-session abort channel. When the runtime asks us to abort a
    // session that isn't the currently-active one, the call is a no-op.
    // The runtime's `stop` behaviour triggers this from inside a handler,
    // at which point the current ctx IS the right session, so the common
    // case works.
    abort: (_sessionId: string) => {
      // No stored ctx here; the tool_call handler intercepts the runtime's
      // thrown Error and converts it to a PI `block` response, which is the
      // canonical way to stop a tool call on PI. For non-tool abort paths
      // we rely on PI surfacing the error and the host tearing down.
    },
    getRootSessionId: (sessionId: string): string => getRootSessionId(sessionId, sessionManager),
    runBash: (request: BashExecutionRequest): Promise<BashHookResult> =>
      executeBashHook({ ...request, projectDir: request.projectDir || projectDir }),
    sendPrompt: (_sessionId: string, text: string): void => {
      // PI's sendUserMessage always targets the current session. For tool:
      // actions runIn: "current" this matches the runtime's intent; runIn:
      // "main" cannot be honoured from a subprocess-less extension and is
      // treated the same as "current".
      try {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      } catch (error) {
        debugLog(
          `sendUserMessage failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    notify: (text: string, level?: HookNotifyLevel): void => {
      // PI's ctx.ui.notify only supports "info" | "warning" | "error".
      // We collapse our "success" level into "info" so the YAML schema
      // stays aligned with common notification systems; if PI adds a
      // native success level in the future we'll forward it verbatim.
      const ctx = getContext();
      if (!ctx?.hasUI || typeof ctx.ui?.notify !== "function") {
        if (!warnedNoNotify) {
          // eslint-disable-next-line no-console
          console.warn(
            "[pi-hooks] notify action skipped: PI UI surface unavailable (likely print/RPC mode).",
          );
          warnedNoNotify = true;
        }
        return;
      }
      const piLevel: "info" | "warning" | "error" =
        level === "warning" || level === "error" ? level : "info";
      try {
        ctx.ui.notify(text, piLevel);
      } catch (error) {
        debugLog(`ui.notify failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    confirm: async (options: { title?: string; message: string }): Promise<boolean> => {
      const ctx = getContext();
      if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") {
        if (!warnedNoConfirm) {
          // eslint-disable-next-line no-console
          console.warn(
            "[pi-hooks] confirm action skipped (auto-approving): PI UI surface unavailable (likely print/RPC mode).",
          );
          warnedNoConfirm = true;
        }
        // No UI to ask — don't block the agent. Treat as approval.
        return true;
      }
      try {
        // PI's confirm takes (title, message) as positional args; title is
        // required on the PI side, so we synthesize a neutral default when
        // the YAML omits it.
        return await ctx.ui.confirm(options.title ?? "Confirm", options.message);
      } catch (error) {
        debugLog(`ui.confirm failed: ${error instanceof Error ? error.message : String(error)}`);
        // Errors from the UI surface (dismissed, aborted) fall through as
        // "not approved" so the runtime's block semantics still fire when
        // the hook is pre-tool.
        return false;
      }
    },
    setStatus: (hookId: string, text: string): void => {
      const ctx = getContext();
      if (!ctx?.hasUI || typeof ctx.ui?.setStatus !== "function") {
        if (!warnedNoSetStatus) {
          // eslint-disable-next-line no-console
          console.warn(
            "[pi-hooks] setStatus action skipped: PI UI surface unavailable (likely print/RPC mode).",
          );
          warnedNoSetStatus = true;
        }
        return;
      }
      try {
        // PI clears a status slot when text is undefined. We expose a plain
        // string-only API at the hook layer and collapse empty strings to
        // "clear" so YAML authors can write `setStatus: ""` to reset.
        ctx.ui.setStatus(hookId, text.length > 0 ? text : undefined);
      } catch (error) {
        debugLog(`ui.setStatus failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
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

function safeGetSessionId(sessionManager: ReadonlySessionManager | undefined): string | undefined {
  if (!sessionManager) return undefined;
  try {
    const id = sessionManager.getSessionId();
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

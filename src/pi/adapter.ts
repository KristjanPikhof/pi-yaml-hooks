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

import path from "node:path";
import { executeBashHook } from "../core/bash-executor.js";
import type { BashExecutionRequest, BashHookResult } from "../core/bash-types.js";
import { getPiHooksLogger } from "../core/logger.js";
import { formatHookLoadSummary, loadDiscoveredHooks } from "../core/load-hooks.js";
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
  const logger = getPiHooksLogger();

  if (process.platform === "win32") {
    // eslint-disable-next-line no-console
    console.warn(
      "[pi-hooks] bash hooks require a POSIX bash on PATH; Windows is unsupported. Extension is a no-op.",
    );
    logger.warn("adapter_disabled", "Windows is unsupported; extension registered as a no-op.", {
      details: { platform: process.platform },
    });
    return;
  }

  // P1 #8 fix: matchesAnyPath / matchesAllPaths conditions use node:path
  // matchesGlob, which exists from Node 22.0.0. Older Node throws TypeError
  // inside shouldRunHook's catch block, silently making path-conditioned
  // hooks never match. Fail loudly at startup instead.
  if (typeof (path as { matchesGlob?: unknown }).matchesGlob !== "function") {
    // eslint-disable-next-line no-console
    console.error(
      `[pi-hooks] node:path.matchesGlob is unavailable on this Node runtime (${process.version}). ` +
        `pi-hooks requires Node >= 22.0.0 for path conditions to work. Extension is a no-op.`,
    );
    logger.error("adapter_disabled", "node:path.matchesGlob is unavailable; extension registered as a no-op.", {
      details: { nodeVersion: process.version },
    });
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
  // P1 #4 fix: PI emits both session_before_switch AND session_shutdown for
  // the same logical /new, /resume, /fork transition. Track which session
  // ids we have already fired session.deleted for so cleanup hooks do not
  // double-run. Entries are cleared shortly after to keep the set bounded.
  const deletedSessionIds = new Set<string>();
  function markSessionDeleted(sessionId: string): boolean {
    if (deletedSessionIds.has(sessionId)) return false;
    deletedSessionIds.add(sessionId);
    // Drop the marker after a few seconds — long enough to absorb the
    // before_switch/shutdown pair, short enough not to leak forever.
    setTimeout(() => deletedSessionIds.delete(sessionId), 5_000).unref?.();
    return true;
  }

  function rememberContext(cwd: string, ctx: ExtensionContext): void {
    latestContexts.set(cwd, ctx);
  }

  function getRuntimeFor(cwd: string): HooksRuntime {
    const existing = runtimes.get(cwd);
    if (existing) return existing;

    // P1 #3 fix: do not close over a particular sessionManager. Read the
    // current one from the latest ctx on every host call so /new, /resume,
    // /fork get the correct lineage.
    const getLiveSessionManager = (): ReadonlySessionManager | undefined =>
      latestContexts.get(cwd)?.sessionManager;
    const host = createHostAdapter(pi, cwd, getLiveSessionManager, () => latestContexts.get(cwd));
    const loaded = loadDiscoveredHooks({ projectDir: cwd });
    if (loaded.errors.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[pi-hooks] Failed to load some hooks; continuing with valid hooks:\n${loaded.errors
          .map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
          .join("\n")}`,
      );
      logger.error("config_load", "Hook loading reported validation errors.", {
        cwd,
        details: {
          files: loaded.files,
          errors: loaded.errors.map((error) => ({
            filePath: error.filePath,
            path: error.path,
            code: error.code,
            message: error.message,
          })),
        },
      });
    }
    const summary = formatHookLoadSummary(loaded);
    // eslint-disable-next-line no-console
    console.info(summary);
    logger.info("config_load", "Hook configuration loaded.", {
      cwd,
      details: { files: loaded.files, summary, sources: loaded.sources },
    });
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

    const runtime = getRuntimeFor(ctx.cwd);
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
      // P2 #18 fix: blocked tool calls never produce a tool_result, so the
      // tool_result handler that normally cleans up callIdsToSessionIds will
      // never fire. Drop the entry here so the map does not leak.
      callIdsToSessionIds.delete(event.toolCallId);
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
        const runtime = getRuntimeFor(ctx.cwd);
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
      const runtime = getRuntimeFor(ctx.cwd);
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

    // P2 #14 fix: include parentID so the runtime's session-state can
    // classify scope:main|child correctly for forked sessions. Without this
    // the runtime treats every session as its own root.
    const parentID = safeGetParentSessionPath(ctx.sessionManager);

    try {
      const runtime = getRuntimeFor(ctx.cwd);
      await runtime.event({
        event: {
          type: "session.created",
          properties: { info: { id: sessionId, parentID } },
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
    if (!markSessionDeleted(sessionId)) return; // already fired via before_switch

    try {
      const runtime = getRuntimeFor(ctx.cwd);
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
    if (!markSessionDeleted(sessionId)) return; // session_shutdown already fired

    try {
      const runtime = getRuntimeFor(ctx.cwd);
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
  getSessionManager: () => ReadonlySessionManager | undefined,
  getContext: () => ExtensionContext | undefined,
): HostAdapter {
  const logger = getPiHooksLogger();
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
    abort: (sessionId: string) => {
      // P2 #20: surface a debug line so operators relying on `behavior: stop`
      // for tool.after.* / session.idle hooks can see why the session
      // wasn't aborted (PI has no extension-side abort outside tool_call).
      debugLog(
        `abort requested for session ${sessionId}: handled via tool_call block result for pre-tool hooks; ` +
          `behavior:stop on tool.after.* or session.idle is a no-op on PI.`,
      );
    },
    getRootSessionId: (sessionId: string): string => getRootSessionId(sessionId, getSessionManager()),
    runBash: (request: BashExecutionRequest): Promise<BashHookResult> =>
      executeBashHook({ ...request, projectDir: request.projectDir || projectDir }),
    sendPrompt: (_sessionId: string, text: string): void => {
      // PI's sendUserMessage always targets the current session. For tool:
      // actions runIn: "current" this matches the runtime's intent; runIn:
      // "main" cannot be honoured from a subprocess-less extension and is
      // treated the same as "current".
      try {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
        logger.info("host_send_prompt", "Queued follow-up prompt in the current PI session.", {
          cwd: projectDir,
          details: { text },
        });
      } catch (error) {
        logger.error("host_send_prompt", "sendUserMessage failed.", {
          cwd: projectDir,
          details: { text, error: error instanceof Error ? error.message : String(error) },
        });
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
          logger.warn("host_notify", "notify action skipped because PI UI surface is unavailable.", {
            cwd: projectDir,
          });
          warnedNoNotify = true;
        }
        return;
      }
      const piLevel: "info" | "warning" | "error" =
        level === "warning" || level === "error" ? level : "info";
      try {
        ctx.ui.notify(text, piLevel);
        logger.info("host_notify", "Delivered UI notification.", {
          cwd: projectDir,
          details: { text, level: piLevel },
        });
      } catch (error) {
        logger.error("host_notify", "UI notification failed.", {
          cwd: projectDir,
          details: { text, level: piLevel, error: error instanceof Error ? error.message : String(error) },
        });
        debugLog(`ui.notify failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    confirm: async (options: { title?: string; message: string }): Promise<boolean> => {
      const ctx = getContext();
      if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") {
        if (!warnedNoConfirm) {
          // eslint-disable-next-line no-console
          console.warn(
            "[pi-hooks] confirm action denied: PI UI surface unavailable (likely print/RPC mode). " +
              "confirm: hooks fail closed in headless mode so destructive operations are not silently auto-approved. " +
              "Set PI_HOOKS_CONFIRM_AUTO_APPROVE=1 to override.",
          );
          logger.warn("host_confirm", "confirm action denied because PI UI surface is unavailable.", {
            cwd: projectDir,
            details: { autoApprove: process.env.PI_HOOKS_CONFIRM_AUTO_APPROVE === "1" },
          });
          warnedNoConfirm = true;
        }
        // P1 #5 fix: fail closed in headless mode. Returning false routes
        // through the runtime's block path for pre-tool hooks. Operators who
        // explicitly want to keep the old behavior can opt back in.
        return process.env.PI_HOOKS_CONFIRM_AUTO_APPROVE === "1";
      }
      try {
        // PI's confirm takes (title, message) as positional args; title is
        // required on the PI side, so we synthesize a neutral default when
        // the YAML omits it.
        const approved = await ctx.ui.confirm(options.title ?? "Confirm", options.message);
        logger.info("host_confirm", "Completed UI confirmation request.", {
          cwd: projectDir,
          details: { title: options.title ?? "Confirm", message: options.message, approved },
        });
        return approved;
      } catch (error) {
        logger.error("host_confirm", "UI confirmation failed.", {
          cwd: projectDir,
          details: { title: options.title ?? "Confirm", message: options.message, error: error instanceof Error ? error.message : String(error) },
        });
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
          logger.warn("host_set_status", "setStatus action skipped because PI UI surface is unavailable.", {
            cwd: projectDir,
          });
          warnedNoSetStatus = true;
        }
        return;
      }
      try {
        // PI clears a status slot when text is undefined. We expose a plain
        // string-only API at the hook layer and collapse empty strings to
        // "clear" so YAML authors can write `setStatus: ""` to reset.
        ctx.ui.setStatus(hookId, text.length > 0 ? text : undefined);
        logger.info("host_set_status", "Updated PI status surface.", {
          cwd: projectDir,
          details: { hookId, text },
        });
      } catch (error) {
        logger.error("host_set_status", "Updating PI status surface failed.", {
          cwd: projectDir,
          details: { hookId, text, error: error instanceof Error ? error.message : String(error) },
        });
        debugLog(`ui.setStatus failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
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

function safeGetParentSessionPath(sessionManager: ReadonlySessionManager | undefined): string | undefined {
  if (!sessionManager) return undefined;
  try {
    const header = sessionManager.getHeader();
    const parent = header?.parentSession;
    return typeof parent === "string" && parent.length > 0 ? parent : undefined;
  } catch {
    return undefined;
  }
}

function debugLog(message: string): void {
  if (process.env.PI_HOOKS_DEBUG) {
    getPiHooksLogger().debug("adapter_debug", message)
    // eslint-disable-next-line no-console
    console.warn(`[pi-hooks] ${message}`);
  }
}

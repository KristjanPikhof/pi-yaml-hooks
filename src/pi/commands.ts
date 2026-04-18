/**
 * PI-native slash commands and status widget for pi-hooks.
 *
 * Exposes two slash commands that wrap the Python `snapshot-worker.py` CLI:
 *
 * - `/snapshot-status` — spawn `snapshot-worker.py --status --repo <cwd>`,
 *   parse the emitted JSON and surface a compact one-line summary via
 *   `ctx.ui.notify`. Falls back to an error notify on non-zero exits or
 *   JSON-parse failures.
 * - `/snapshot-flush`  — spawn `snapshot-worker.py --flush --repo <cwd>`.
 *   Exit 0 → success, exit 2 → work remains (documented "another worker /
 *   more work pending" signal), other exits → error.
 *
 * Also exposes a queue-depth status widget:
 *
 * - `startSnapshotStatusWidget(pi)` polls `--status` every 5 seconds and
 *   updates `ctx.ui.setWidget("snapshot", …)` with the current queue depth.
 *   Because `setWidget` lives on `ExtensionUIContext` (per-invocation `ctx`)
 *   rather than `ExtensionAPI`, we capture the most recent `ctx` via a
 *   non-invasive `session_start` fanout. If `ctx.hasUI` is false (print /
 *   RPC mode) we silently skip widget updates — polling still runs so status
 *   is warm if the mode ever gains UI.
 * - `stopSnapshotStatusWidget(pi)` clears the interval and clears the widget.
 *
 * This module never touches `adapter.ts`. `src/index.ts` wires the
 * session_start/session_shutdown listeners alongside the adapter's own.
 * Multiple handlers for the same PI event are supported (pi.on appends),
 * so both the adapter and this module coexist cleanly.
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";

const PYTHON_EXECUTABLE = process.env.PI_HOOKS_PYTHON || "python3";
const WIDGET_KEY = "snapshot";
const POLL_INTERVAL_MS = 5_000;

interface StatusCounts {
  pending: number;
  publishing: number;
  published: number;
  blocked_conflict: number;
  failed: number;
}

interface StatusSnapshot {
  db: string;
  counts: StatusCounts;
  path_tails: number;
  worker: { pid: number; heartbeat_ts: number; last_enqueue_ts: number };
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Resolve the snapshot-worker.py script path. Mirrors python-bridge.ts'
 * resolution: walk two levels up from this source file so it works from
 * both `src/pi/` and `dist/pi/` layouts.
 */
function resolveSnapshotWorkerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "python", "atomic-commit-snapshot-worker", "snapshot-worker.py");
}

function runSnapshotWorker(args: readonly string[], cwd: string): Promise<RunResult> {
  const script = resolveSnapshotWorkerScript();
  return new Promise<RunResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let child;
    try {
      child = spawn(PYTHON_EXECUTABLE, [script, ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      settle({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      settle({ stdout, stderr: stderr + error.message, exitCode: -1 });
    });
    child.on("close", (code: number | null) => {
      settle({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function parseStatus(stdout: string): StatusSnapshot | undefined {
  try {
    const parsed = JSON.parse(stdout) as StatusSnapshot;
    if (!parsed || typeof parsed !== "object" || !parsed.counts) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function formatSummary(snapshot: StatusSnapshot): string {
  const c = snapshot.counts;
  return `Snapshot: pending=${c.pending} publishing=${c.publishing} published=${c.published} blocked=${c.blocked_conflict} failed=${c.failed}`;
}

function truncate(value: string, max = 400): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function debugLog(message: string): void {
  if (process.env.PI_HOOKS_DEBUG) {
    // eslint-disable-next-line no-console
    console.warn(`[pi-hooks] ${message}`);
  }
}

/**
 * Shared widget state. A single module-level record is correct because a PI
 * process hosts one active session/UI at a time — even across `/new` the UI
 * instance is the same; we just re-point `lastCtx` when session_start fires.
 */
interface WidgetState {
  timer: NodeJS.Timeout | undefined;
  lastCtx: ExtensionContext | undefined;
  lastCwd: string | undefined;
}
const widgetState: WidgetState = {
  timer: undefined,
  lastCtx: undefined,
  lastCwd: undefined,
};

async function pollAndRenderWidget(): Promise<void> {
  const ctx = widgetState.lastCtx;
  const cwd = widgetState.lastCwd ?? ctx?.cwd;
  if (!ctx || !cwd) return;

  const result = await runSnapshotWorker(["--status", "--repo", cwd], cwd);
  if (result.exitCode !== 0) {
    debugLog(
      `status poll exited ${result.exitCode}` +
        (result.stderr ? `: ${truncate(result.stderr)}` : ""),
    );
    return;
  }
  const snapshot = parseStatus(result.stdout);
  if (!snapshot) {
    debugLog(`status poll: JSON parse failed; stdout=${truncate(result.stdout)}`);
    return;
  }

  if (!ctx.hasUI) return; // print/RPC mode: widget UI unavailable
  try {
    const lines = [
      `queue: ${snapshot.counts.pending}  publishing: ${snapshot.counts.publishing}`,
      `published: ${snapshot.counts.published}  failed: ${snapshot.counts.failed}`,
    ];
    ctx.ui.setWidget(WIDGET_KEY, lines);
  } catch (error) {
    debugLog(
      `setWidget failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Register both slash commands on the PI extension API. Idempotent only in the
 * sense that PI itself rejects duplicate command names — callers should invoke
 * this exactly once per extension load.
 */
export function registerSnapshotCommands(pi: ExtensionAPI): void {
  pi.registerCommand("snapshot-status", {
    description: "Show atomic-commit snapshot queue status",
    handler: async (_args, ctx) => {
      const result = await runSnapshotWorker(["--status", "--repo", ctx.cwd], ctx.cwd);
      if (result.exitCode !== 0) {
        ctx.ui.notify(
          `snapshot-status failed (exit ${result.exitCode})` +
            (result.stderr ? `: ${truncate(result.stderr)}` : ""),
          "error",
        );
        return;
      }
      const snapshot = parseStatus(result.stdout);
      if (!snapshot) {
        ctx.ui.notify(
          `snapshot-status: could not parse JSON; stdout=${truncate(result.stdout)}`,
          "error",
        );
        return;
      }
      ctx.ui.notify(formatSummary(snapshot), "info");
    },
  });

  pi.registerCommand("snapshot-flush", {
    description: "Drain the atomic-commit snapshot queue",
    handler: async (_args, ctx) => {
      const result = await runSnapshotWorker(["--flush", "--repo", ctx.cwd], ctx.cwd);
      if (result.exitCode === 0) {
        ctx.ui.notify("Snapshot flush complete", "info");
        return;
      }
      if (result.exitCode === 2) {
        ctx.ui.notify(
          `Snapshot flush: work remains` +
            (result.stderr ? ` — ${truncate(result.stderr)}` : ""),
          "warning",
        );
        return;
      }
      ctx.ui.notify(
        `snapshot-flush failed (exit ${result.exitCode})` +
          (result.stderr ? `: ${truncate(result.stderr)}` : ""),
        "error",
      );
    },
  });

  // eslint-disable-next-line no-console
  console.warn("[pi-hooks] registered commands snapshot-status, snapshot-flush");
}

/**
 * Record the latest PI `ctx` so the widget poller can call `ctx.ui.setWidget`.
 * Called from index.ts's session_start listener. Safe to call repeatedly.
 */
export function rememberWidgetContext(ctx: ExtensionContext): void {
  widgetState.lastCtx = ctx;
  widgetState.lastCwd = ctx.cwd;
}

/**
 * Start polling the snapshot worker status every 5s and pushing the result
 * to the PI widget surface. Idempotent: calling twice is a no-op.
 */
export function startSnapshotStatusWidget(_pi: ExtensionAPI): void {
  if (widgetState.timer) return;
  // Fire one immediate poll so the widget has data before the first tick.
  void pollAndRenderWidget();
  widgetState.timer = setInterval(() => {
    void pollAndRenderWidget();
  }, POLL_INTERVAL_MS);
  // Allow the process to exit naturally; don't hold the event loop open.
  if (typeof widgetState.timer.unref === "function") widgetState.timer.unref();
}

/**
 * Stop the status widget poller and clear the widget from the UI.
 */
export function stopSnapshotStatusWidget(_pi: ExtensionAPI): void {
  if (widgetState.timer) {
    clearInterval(widgetState.timer);
    widgetState.timer = undefined;
  }
  const ctx = widgetState.lastCtx;
  if (ctx && ctx.hasUI) {
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch (error) {
      debugLog(
        `setWidget(clear) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  widgetState.lastCtx = undefined;
  widgetState.lastCwd = undefined;
}

/**
 * Typed aliases re-exported so index.ts can reference the event shapes without
 * re-importing them from the PI package in two places.
 */
export type { SessionShutdownEvent, SessionStartEvent };

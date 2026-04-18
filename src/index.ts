/**
 * pi-hooks — PI extension entry point.
 *
 * Registers the YAML-driven hooks adapter that wires PI events into the core
 * runtime (`src/core/runtime.ts`) and preserves the Phase 1 atomic-commit
 * snapshot pipeline. On top of that, registers the PI-native slash commands
 * (`/snapshot-status`, `/snapshot-flush`) and starts/stops the queue-depth
 * status widget in lock-step with the PI session lifecycle.
 *
 * The widget listeners are registered here rather than inside adapter.ts so
 * the two lanes stay decoupled. PI's `pi.on` supports multiple handlers per
 * event (they are appended), so the adapter's own session_start /
 * session_shutdown handlers continue to run unchanged.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";

import { registerAdapter } from "./pi/adapter.js";
import {
  registerSnapshotCommands,
  rememberWidgetContext,
  startSnapshotStatusWidget,
  stopSnapshotStatusWidget,
} from "./pi/commands.js";

export default function piHooksExtension(pi: ExtensionAPI): void {
  registerAdapter(pi);

  // Windows is unsupported by the adapter (snapshot-worker needs POSIX
  // signals); keep parity here by skipping command + widget registration.
  if (process.platform === "win32") return;

  registerSnapshotCommands(pi);

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
    rememberWidgetContext(ctx);
    startSnapshotStatusWidget(pi);
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, _ctx: ExtensionContext): Promise<void> => {
    stopSnapshotStatusWidget(pi);
  });
}

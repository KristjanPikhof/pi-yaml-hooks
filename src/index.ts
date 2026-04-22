/**
 * pi-hooks — PI extension entry point.
 *
 * Registers the YAML-driven hooks adapter that wires PI events into the core
 * runtime (`src/core/runtime.ts`). The atomic-commit-snapshot-worker is an
 * opt-in example wired via `hooks.yaml` (see
 * `examples/atomic-commit-snapshot-worker/`); nothing is invoked here.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerAdapter } from "./pi/adapter.js";
import { registerCommands } from "./pi/commands.js";
import { registerHookDiagnostics } from "./pi/diagnostics.js";
import { registerPromptSupport } from "./pi/prompt-support.js";

export default function piHooksExtension(pi: ExtensionAPI): void {
  registerHookDiagnostics(pi);
  registerPromptSupport(pi);
  registerCommands(pi);
  registerAdapter(pi);
}

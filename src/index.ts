/**
 * pi-yaml-hooks — PI extension entry point.
 *
 * Registers the YAML-driven hooks adapter that wires PI events into the core
 * runtime (`src/core/runtime.ts`). The atomic-commit-snapshot-worker is an
 * opt-in example wired via `hooks.yaml` (see
 * `examples/atomic-commit-snapshot-worker/`); nothing is invoked here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Side-effect import: registers the PI HookPolicy with the core loader so
// `unsupported_on_pi` diagnostics fire on every parse. P2 #22: core no longer
// imports from `src/pi/*`, so production must opt the policy in here.
import "./pi/unsupported.js";
import { registerAdapter } from "./pi/adapter.js";
import { registerHookAutocomplete } from "./pi/autocomplete.js";
import { registerCommands } from "./pi/commands.js";
import { registerHookDiagnostics } from "./pi/diagnostics.js";
import { registerPromptSupport } from "./pi/prompt-support.js";

export default function piHooksExtension(pi: ExtensionAPI): void {
  registerHookDiagnostics(pi);
  registerPromptSupport(pi);
  registerCommands(pi);
  pi.on("session_start", (_event, ctx) => registerHookAutocomplete(ctx));
  pi.on("before_agent_start", (_event, ctx) => registerHookAutocomplete(ctx));
  registerAdapter(pi);
}

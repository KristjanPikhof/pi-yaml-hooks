/**
 * pi-hooks — PI extension entry point.
 *
 * Phase 1 MVP: wires PI `tool_result` / `session_shutdown` /
 * `session_before_switch` into the Python atomic-commit-snapshot worker via
 * the adapter in `./pi/adapter.ts`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerPhase1Adapter } from "./pi/adapter.js";

export default function piHooksExtension(pi: ExtensionAPI): void {
  registerPhase1Adapter(pi);
}

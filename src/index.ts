/**
 * pi-hooks — PI extension entry point.
 *
 * Registers the YAML-driven hooks adapter that wires PI events into the core
 * runtime (`src/core/runtime.ts`) and preserves the Phase 1 atomic-commit
 * snapshot pipeline.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerAdapter } from "./pi/adapter.js";

export default function piHooksExtension(pi: ExtensionAPI): void {
  registerAdapter(pi);
}

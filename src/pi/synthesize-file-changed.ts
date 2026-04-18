/**
 * Synthesize the `file.changed` payload that the Python snapshot-hook expects,
 * from a PI `tool_result` event.
 *
 * Phase 1 handles only the PI built-in tools `write` and `edit`. Other tools
 * (including `bash`) are skipped — there is no bash inference in Phase 1.
 *
 * The shape is intentionally aligned with the payload consumed in
 * `python/atomic-commit-snapshot-worker/snapshot-hook.py::extract_changes`:
 *
 *   {
 *     event:       "file.changed",
 *     cwd:         string,
 *     session_id:  string | undefined,
 *     tool_name:   "write" | "edit",
 *     tool_input:  { file_path: string, ... },
 *     files:       string[],            // modified paths
 *     changes:     [{ operation, path }] // "modify" for both write & edit
 *   }
 */

import type { ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@mariozechner/pi-coding-agent";

/**
 * Payload shape consumed by the Python snapshot hook. Kept local to Phase 1
 * so we don't leak anything into `src/core/` which is owned by another lane.
 */
export interface FileChangedHookPayload {
  event: "file.changed";
  cwd: string;
  session_id?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  files: string[];
  changes: Array<{ operation: "modify"; path: string }>;
}

export interface SynthesizeOptions {
  /** Working directory. Forwarded into the payload as `cwd`. */
  cwd: string;
  /** Active session id. Forwarded as `session_id` when present. */
  sessionId?: string;
}

/**
 * Build the `file.changed` payload for a PI `tool_result` event.
 *
 * Returns `null` when the event does not represent a user-visible file
 * mutation we should forward to the Python hook (e.g. read/grep/ls, a
 * bash result, or a write/edit that errored without producing a path).
 */
export function synthesizeFileChangedFromToolResult(
  event: ToolResultEvent,
  options: SynthesizeOptions,
): FileChangedHookPayload | null {
  // Skip anything that errored — the file mutation did not (reliably) happen.
  if (event.isError) return null;

  // Only write/edit produce the Phase-1 file.changed surface.
  let filePath: string | undefined;
  let toolInput: Record<string, unknown>;

  if (isWriteToolResult(event) || isEditToolResult(event)) {
    const input = event.input as { path?: unknown; file_path?: unknown };
    if (typeof input.path === "string" && input.path.length > 0) {
      filePath = input.path;
    } else if (typeof input.file_path === "string" && input.file_path.length > 0) {
      filePath = input.file_path;
    }
    toolInput = event.input as Record<string, unknown>;
  } else {
    // Other tools (bash/read/grep/find/ls/custom) are not synthesized in Phase 1.
    return null;
  }

  if (!filePath) return null;

  const payload: FileChangedHookPayload = {
    event: "file.changed",
    cwd: options.cwd,
    tool_name: event.toolName,
    tool_input: toolInput,
    files: [filePath],
    changes: [{ operation: "modify", path: filePath }],
  };

  if (options.sessionId) {
    payload.session_id = options.sessionId;
  }

  return payload;
}

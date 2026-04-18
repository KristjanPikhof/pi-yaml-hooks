/**
 * Python bridge for the atomic-commit-snapshot-worker Python assets.
 *
 * Phase 1 MVP: spawn the Python hook / worker as a child process and feed
 * it a JSON payload on stdin. Exposes a flush helper for session shutdown /
 * session switch paths.
 *
 * The python assets ship inside this package under
 * `python/atomic-commit-snapshot-worker/` and are resolved relative to this
 * source file via `import.meta.url` so it works from both `src/` and `dist/`.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface PythonRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Override the python executable via env var. Defaults to `python3`.
 */
const PYTHON_EXECUTABLE = process.env.PI_HOOKS_PYTHON || "python3";

/**
 * Resolve the absolute path to the `atomic-commit-snapshot-worker` python
 * directory that ships with this package. We walk up from this module's
 * location: `<pkg>/src/pi/python-bridge.ts` or `<pkg>/dist/pi/python-bridge.js`
 * both live two levels below the package root, so `../../python/...` works in
 * both layouts.
 */
function resolvePythonAssetDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "python", "atomic-commit-snapshot-worker");
}

function resolveSnapshotHookScript(): string {
  return resolve(resolvePythonAssetDir(), "snapshot-hook.py");
}

function resolveSnapshotWorkerScript(): string {
  return resolve(resolvePythonAssetDir(), "snapshot-worker.py");
}

/**
 * Run the snapshot hook with a JSON payload on stdin.
 *
 * Resolves with the captured stdout/stderr and the child's exit code (or -1
 * on spawn failure). Does not throw on non-zero exits; callers decide how to
 * handle failure (typically: log at debug and continue).
 */
export function runPythonSnapshotHook(
  payload: Record<string, unknown>,
  options: { cwd?: string } = {},
): Promise<PythonRunResult> {
  const script = resolveSnapshotHookScript();
  const cwd = options.cwd ?? (typeof payload.cwd === "string" ? payload.cwd : process.cwd());

  return new Promise<PythonRunResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: PythonRunResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let child;
    try {
      child = spawn(PYTHON_EXECUTABLE, [script], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
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

    if (child.stdin) {
      child.stdin.on("error", () => {
        // ignore EPIPE etc.; close handler will settle
      });
      try {
        child.stdin.end(JSON.stringify(payload));
      } catch {
        // settle via close/error
      }
    }
  });
}

/**
 * Flush the snapshot worker for a given repo. Equivalent to invoking
 * `snapshot-worker.py --flush --repo <path>`. Used on session shutdown and
 * session switch so the queue drains before the process or session changes.
 */
export function runSnapshotWorkerFlush(repoPath: string): Promise<PythonRunResult> {
  const script = resolveSnapshotWorkerScript();

  return new Promise<PythonRunResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: PythonRunResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    let child;
    try {
      child = spawn(PYTHON_EXECUTABLE, [script, "--flush", "--repo", repoPath], {
        cwd: repoPath,
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

import { execFileSync, spawn } from "node:child_process"
import path from "node:path"

import {
  DEFAULT_BASH_TIMEOUT,
  type BashExecutionRequest,
  type BashHookContext,
  type BashHookResult,
  type BashProcessResult,
} from "./bash-types.js"

const TIMEOUT_EXIT_CODE = 1
const BLOCKING_EXIT_CODE = 2
const KILL_GRACE_PERIOD_MS = 250
// Prefer the PI-native override, but fall back to the legacy OpenCode env var so
// existing deployments continue to work during the transition.
const BASH_EXECUTABLE = process.env.PI_HOOKS_BASH_EXECUTABLE || process.env.OPENCODE_HOOKS_BASH_EXECUTABLE || "bash"
const MAX_LOG_FIELD_LENGTH = 400
const REDACTED = "[REDACTED]"
const SUPPORTS_PROCESS_GROUP_TIMEOUT_KILL = process.platform !== "win32"
// P1 #9: cap captured stdout/stderr per hook invocation. A misbehaving hook
// (e.g. `find / -type f`) would otherwise buffer arbitrarily large output
// into the host process. Override via PI_HOOKS_MAX_OUTPUT_BYTES.
const MAX_OUTPUT_BYTES = parseMaxOutputBytes(process.env.PI_HOOKS_MAX_OUTPUT_BYTES) ?? 1_048_576
const TRUNCATION_MARKER = "\n…[pi-hooks: output truncated]"

function parseMaxOutputBytes(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function appendCapped(existing: string, chunk: Buffer): string {
  if (existing.length >= MAX_OUTPUT_BYTES) return existing
  const remaining = MAX_OUTPUT_BYTES - existing.length
  if (chunk.length <= remaining) return existing + chunk.toString()
  return existing + chunk.toString("utf8", 0, remaining) + TRUNCATION_MARKER
}

export async function executeBashHook(request: BashExecutionRequest): Promise<BashHookResult> {
  const processResult = await executeBashProcess(request)
  const hookResult = mapBashProcessResultToHookResult(processResult, request.context)

  logBashOutcome(hookResult, request)
  return hookResult
}

export function mapBashProcessResultToHookResult(result: BashProcessResult, context: BashHookContext): BashHookResult {
  if (result.timedOut) {
    return { ...result, status: "timed_out", blocking: false }
  }

  if (result.exitCode === 0) {
    return { ...result, status: "success", blocking: false }
  }

  if (result.exitCode === BLOCKING_EXIT_CODE && isBlockingToolBeforeEvent(context.event)) {
    return { ...result, status: "blocked", blocking: true }
  }

  return { ...result, status: "failed", blocking: false }
}

export function isBlockingToolBeforeEvent(event: string): boolean {
  return event.startsWith("tool.before.")
}

async function executeBashProcess(request: BashExecutionRequest): Promise<BashProcessResult> {
  const timeout = request.timeout ?? DEFAULT_BASH_TIMEOUT
  const startTime = Date.now()
  const executionContext = resolveExecutionContext(request.projectDir)

  return new Promise((resolve) => {
    // Inject both PI_* (canonical) and OPENCODE_* (legacy alias) env vars so that
    // bash actions migrated from OpenCode — including the Python snapshot-hook.py
    // worker which reads OPENCODE_PROJECT_DIR — keep working unchanged.
    const env = {
      ...process.env,
      PI_PROJECT_DIR: request.projectDir,
      OPENCODE_PROJECT_DIR: request.projectDir,
      PI_WORKTREE_DIR: executionContext.worktreeDir,
      OPENCODE_WORKTREE_DIR: executionContext.worktreeDir,
      PI_SESSION_ID: request.context.session_id,
      OPENCODE_SESSION_ID: request.context.session_id,
      ...(executionContext.gitCommonDir
        ? {
            PI_GIT_COMMON_DIR: executionContext.gitCommonDir,
            OPENCODE_GIT_COMMON_DIR: executionContext.gitCommonDir,
          }
        : {}),
    }

    const child = spawn(BASH_EXECUTABLE, ["-c", request.command], {
      cwd: request.context.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: SUPPORTS_PROCESS_GROUP_TIMEOUT_KILL,
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const timeoutCleanupNotes: string[] = []

    const finalize = (result: Omit<BashProcessResult, "durationMs">): void => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer) {
        clearTimeout(killTimer)
      }

      resolve({
        ...result,
        durationMs: Date.now() - startTime,
      })
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      const sigtermResult = signalTimedOutProcess(child, "SIGTERM")
      timeoutCleanupNotes.push(...formatTimeoutCleanupLines(sigtermResult, timeout, "SIGTERM"))
      killTimer = setTimeout(() => {
        const sigkillResult = signalTimedOutProcess(child, "SIGKILL")
        timeoutCleanupNotes.push(...formatTimeoutCleanupLines(sigkillResult, timeout, "SIGKILL"))
      }, KILL_GRACE_PERIOD_MS)
    }, timeout)

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk)
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk)
    })

    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(request.context))

    child.on("error", (error) => {
      finalize({
        command: request.command,
        stdout,
        stderr: appendStderr(stderr, error.message),
        exitCode: TIMEOUT_EXIT_CODE,
        signal: null,
        timedOut: false,
      })
    })

    child.on("close", (code, signal) => {
      const exitCode = timedOut ? TIMEOUT_EXIT_CODE : (code ?? TIMEOUT_EXIT_CODE)
      const timeoutMessages = timedOut
        ? [
            `Command timed out after ${timeout}ms`,
            ...timeoutCleanupNotes,
            `Timeout cleanup: final result exitCode=${code ?? "none"} signal=${signal ?? "none"}`,
          ]
        : []

      finalize({
        command: request.command,
        stdout,
        stderr: appendStderrLines(stderr, timeoutMessages),
        exitCode,
        signal,
        timedOut,
      })
    })
  })
}

function appendStderr(stderr: string, message?: string): string {
  if (!message) {
    return stderr
  }

  if (!stderr) {
    return message
  }

  return `${stderr}${stderr.endsWith("\n") ? "" : "\n"}${message}`
}

function appendStderrLines(stderr: string, messages: readonly string[]): string {
  if (messages.length === 0) {
    return stderr
  }

  return messages.reduce((current, message) => appendStderr(current, message), stderr)
}

function signalTimedOutProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): {
  readonly signal: NodeJS.Signals
  readonly target: "process_group" | "process"
  readonly targetPid?: number
  readonly error?: string
} {
  const pid = child.pid ?? undefined
  if (SUPPORTS_PROCESS_GROUP_TIMEOUT_KILL && typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal)
      return { signal, target: "process_group", targetPid: pid }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        child.kill(signal)
        return { signal, target: "process", targetPid: pid, error: `process group kill failed: ${message}` }
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        return {
          signal,
          target: "process",
          targetPid: pid,
          error: `process group kill failed: ${message}; fallback process kill failed: ${fallbackMessage}`,
        }
      }
    }
  }

  try {
    child.kill(signal)
    return { signal, target: "process", ...(pid ? { targetPid: pid } : {}) }
  } catch (error) {
    return {
      signal,
      target: "process",
      ...(pid ? { targetPid: pid } : {}),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function formatTimeoutCleanupLines(
  result: {
    readonly signal: NodeJS.Signals
    readonly target: "process_group" | "process"
    readonly targetPid?: number
    readonly error?: string
  },
  timeout: number,
  signal: NodeJS.Signals,
): string[] {
  const pidText = result.targetPid !== undefined ? ` ${result.targetPid}` : ""
  const targetText = result.target === "process_group" ? `process group${pidText}` : `process${pidText}`
  const action = signal === "SIGKILL" ? `escalated to ${signal}` : `sent ${signal}`
  const lines = [`Timeout cleanup: ${action} to ${targetText} after ${timeout}ms timeout`]
  if (result.error) {
    lines.push(`Timeout cleanup: ${result.error}`)
  }
  return lines
}

function logBashOutcome(result: BashHookResult, request: BashExecutionRequest): void {
  if (result.status !== "failed" && result.status !== "timed_out") {
    return
  }

  const details = [
    `[pi-hooks] Bash hook ${result.status}`,
    `event=${request.context.event}`,
    `session=${request.context.session_id}`,
    `cwd=${request.context.cwd}`,
    `projectDir=${request.projectDir}`,
    `exitCode=${result.exitCode}`,
    `signal=${result.signal ?? "none"}`,
    `durationMs=${result.durationMs}`,
    `command=${JSON.stringify(sanitizeLogValue(result.command))}`,
  ]

  if (result.stderr.trim()) {
    details.push(`stderr=${JSON.stringify(sanitizeLogValue(result.stderr.trim()))}`)
  }

  if (result.stdout.trim()) {
    details.push(`stdout=${JSON.stringify(sanitizeLogValue(result.stdout.trim()))}`)
  }

  console.error(details.join(" | "))
}

function sanitizeLogValue(value: string): string {
  const redacted = redactSensitiveContent(value)
  if (redacted.length <= MAX_LOG_FIELD_LENGTH) {
    return redacted
  }

  return `${redacted.slice(0, MAX_LOG_FIELD_LENGTH)}… [truncated ${redacted.length - MAX_LOG_FIELD_LENGTH} chars]`
}

function redactSensitiveContent(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*bearer\s+)([^\s]+)/gi, `$1${REDACTED}`)
    .replace(
      /((?:\\?["'])?(?:api[-_ ]?key|token|secret|password|passwd|pwd)(?:\\?["'])?[^\S\r\n]*[:=][^\S\r\n]*)(\\?["'])(.*?)(\2)/gi,
      (_match, prefix: string, openingQuote: string, _secretValue: string, closingQuote: string) =>
        `${prefix}${openingQuote}${REDACTED}${closingQuote}`,
    )
    .replace(
      /(["']?(?:api[-_ ]?key|token|secret|password|passwd|pwd)["']?[^\S\r\n]*[:=][^\S\r\n]*)([^\s,"'}\]`]+)/gi,
      `$1${REDACTED}`,
    )
}

function resolveExecutionContext(projectDir: string): { worktreeDir: string; gitCommonDir?: string; resolvedFromGit: boolean } {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()

    const [worktreeDirLine, gitCommonDirLine] = output.split(/\r?\n/)
    const worktreeDir = worktreeDirLine?.trim() || projectDir
    const gitCommonDir = gitCommonDirLine?.trim()

    return {
      worktreeDir,
      resolvedFromGit: true,
      ...(gitCommonDir
        ? {
            gitCommonDir: path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(projectDir, gitCommonDir),
          }
        : {}),
    }
  } catch {
    return { worktreeDir: projectDir, resolvedFromGit: false }
  }
}

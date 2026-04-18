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
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

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
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        child.kill("SIGKILL")
      }, KILL_GRACE_PERIOD_MS)
    }, timeout)

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
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
      const timeoutMessage = timedOut ? `Command timed out after ${timeout}ms` : undefined

      finalize({
        command: request.command,
        stdout,
        stderr: appendStderr(stderr, timeoutMessage),
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

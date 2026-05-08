import { randomUUID as nodeRandomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ExtensionAPI, ExtensionContext, UserBashEvent, UserBashEventResult } from "@earendil-works/pi-coding-agent"

import { getPiHooksLogger } from "../core/logger.js"
import type { HooksRuntime } from "../core/runtime.js"

const ENABLE_USER_BASH_ENV = "PI_YAML_HOOKS_ENABLE_USER_BASH"

// Monotonic fallback counter used when crypto.randomUUID is unavailable.
let _monotonicCounter = 0

function generateCallId(): string {
  try {
    return nodeRandomUUID()
  } catch {
    return `fallback-${Date.now()}-${(_monotonicCounter += 1)}`
  }
}

// One-time warning tracking: warn once per process when user_bash is enabled.
let _userBashWarningEmitted = false

function emitUserBashWarningOnce(): void {
  if (_userBashWarningEmitted) return
  _userBashWarningEmitted = true

  const trustedProjects = readTrustedProjectsList()
  const projectList =
    trustedProjects.length > 0
      ? trustedProjects.map((p) => `  - ${p}`).join("\n")
      : "  (no projects currently in trusted-projects.json)"

  process.stderr.write(
    `[pi-yaml-hooks] WARNING: PI_YAML_HOOKS_ENABLE_USER_BASH=1 is set.\n` +
    `  Every human "!" / "!!" shell command typed in PI will be routed through\n` +
    `  tool.before.bash hooks before execution. Hooks in trusted projects can:\n` +
    `    - observe the full command text\n` +
    `    - block the command (exit code 2)\n` +
    `    - read PI_TOOL_ARGS to exfiltrate command content via bash actions\n` +
    `  Trusted projects whose hooks will see your typed commands:\n` +
    `${projectList}\n` +
    `  Only enable this feature if you trust all hooks in the listed projects.\n`,
  )
}

function readTrustedProjectsList(): string[] {
  try {
    const homeDir = os.homedir()
    const trustFile = path.join(homeDir, ".pi", "agent", "trusted-projects.json")
    if (!existsSync(trustFile)) return []
    const raw = readFileSync(trustFile, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === "string")
  } catch {
    return []
  }
}

export function registerUserBashInterception(
  pi: ExtensionAPI,
  options: {
    getRuntimeFor: (cwd: string) => HooksRuntime
    rememberContext: (cwd: string, ctx: ExtensionContext) => void
    getSessionId: (ctx: ExtensionContext) => string | undefined
  },
): void {
  if (process.env[ENABLE_USER_BASH_ENV] === "1") {
    emitUserBashWarningOnce()
  }

  pi.on("user_bash", async (event: UserBashEvent, ctx: ExtensionContext): Promise<UserBashEventResult | void> => {
    if (process.env[ENABLE_USER_BASH_ENV] !== "1") {
      return
    }

    options.rememberContext(ctx.cwd, ctx)
    const sessionId = options.getSessionId(ctx)
    if (!sessionId) {
      return
    }

    const runtime = options.getRuntimeFor(ctx.cwd)
    try {
      await runtime["user.bash.before"](
        {
          tool: "bash",
          sessionID: sessionId,
          callID: `user-bash:${sessionId}:${generateCallId()}`,
        },
        {
          args: { command: event.command },
        },
      )
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        result: {
          output: `[pi-yaml-hooks] user_bash blocked: ${message}`,
          exitCode: undefined,
          cancelled: true,
          truncated: false,
        },
      }
    }
  })
}

// Exported for testing only.
export { generateCallId, emitUserBashWarningOnce as _emitUserBashWarningOnce, _monotonicCounter }
export function _resetUserBashWarningForTests(): void {
  _userBashWarningEmitted = false
}

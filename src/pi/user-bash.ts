import type { ExtensionAPI, ExtensionContext, UserBashEvent, UserBashEventResult } from "@mariozechner/pi-coding-agent"

import type { HooksRuntime } from "../core/runtime.js"

const ENABLE_USER_BASH_ENV = "PI_HOOKS_ENABLE_USER_BASH"

export function registerUserBashInterception(
  pi: ExtensionAPI,
  options: {
    getRuntimeFor: (cwd: string) => HooksRuntime
    rememberContext: (cwd: string, ctx: ExtensionContext) => void
    getSessionId: (ctx: ExtensionContext) => string | undefined
  },
): void {
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
          callID: `user-bash:${sessionId}:${Date.now()}`,
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
          output: `[pi-hooks] user_bash blocked: ${message}`,
          exitCode: undefined,
          cancelled: true,
          truncated: false,
        },
      }
    }
  })
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { resetPiHooksLoggerForTests } from "../core/logger.js"
import { registerAdapter } from "./adapter.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

type AgentEndHandler = (event: unknown, ctx: unknown) => Promise<void> | void

function createFakePi(): {
  readonly pi: Parameters<typeof registerAdapter>[0]
  readonly handlers: Map<string, AgentEndHandler>
} {
  const handlers = new Map<string, AgentEndHandler>()
  const pi = {
    on: (event: string, handler: AgentEndHandler) => {
      handlers.set(event, handler)
    },
    sendUserMessage: () => {},
  } as unknown as Parameters<typeof registerAdapter>[0]

  return { pi, handlers }
}

function createContext(cwd: string, notifications: string[]) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify: (text: string) => {
        notifications.push(text)
      },
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getHeader: () => ({}),
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as never
}

function writeProjectHooks(projectDir: string, content: string): void {
  const filePath = path.join(projectDir, ".pi", "hook", "hooks.yaml")
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

async function dispatchIdle(handlers: Map<string, AgentEndHandler>, ctx: unknown): Promise<void> {
  const handler = handlers.get("agent_end")
  if (!handler) {
    throw new Error("agent_end handler was not registered")
  }

  await handler({}, ctx)
}

const cases: Case[] = [
  {
    name: "adapter reloads edited hooks and keeps the last known good config on invalid edits",
    run: async () => {
      const tempProject = mkdtempSync(path.join(os.tmpdir(), "pi-hooks-adapter-"))
      const previousTrust = process.env.PI_HOOKS_TRUST_PROJECT
      const previousWarn = console.warn
      const previousInfo = console.info
      const previousError = console.error
      process.env.PI_HOOKS_TRUST_PROJECT = "1"
      resetPiHooksLoggerForTests()
      console.warn = () => {}
      console.info = () => {}
      console.error = () => {}

      try {
        writeProjectHooks(
          tempProject,
          `hooks:
  - event: session.idle
    actions:
      - notify: "idle-v1"
`,
        )

        const notifications: string[] = []
        const { pi, handlers } = createFakePi()
        registerAdapter(pi)
        const ctx = createContext(tempProject, notifications)

        await dispatchIdle(handlers, ctx)

        writeProjectHooks(
          tempProject,
          `hooks:
  - event: session.idle
    actions:
      - notify: "idle-version-two"
`,
        )
        await dispatchIdle(handlers, ctx)

        writeProjectHooks(
          tempProject,
          `hooks:
  - event: session.idle
    actions:
      - notify:
`,
        )
        await dispatchIdle(handlers, ctx)

        return JSON.stringify(notifications) === JSON.stringify(["idle-v1", "idle-version-two", "idle-version-two"])
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(notifications)}` }
      } finally {
        console.warn = previousWarn
        console.info = previousInfo
        console.error = previousError
        if (previousTrust === undefined) delete process.env.PI_HOOKS_TRUST_PROJECT
        else process.env.PI_HOOKS_TRUST_PROJECT = previousTrust
        resetPiHooksLoggerForTests()
        rmSync(tempProject, { recursive: true, force: true })
      }
    },
  },
]

export async function main(): Promise<number> {
  let failures = 0
  for (const c of cases) {
    try {
      const outcome = await c.run()
      if (outcome.ok) {
        console.info(`PASS  ${c.name}`)
      } else {
        failures += 1
        console.info(`FAIL  ${c.name} -- ${outcome.detail ?? "no detail"}`)
      }
    } catch (error) {
      failures += 1
      console.info(`FAIL  ${c.name} -- threw ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.info(`\n${cases.length - failures}/${cases.length} passed`)
  return failures === 0 ? 0 : 1
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /adapter\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}

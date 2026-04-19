import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { getPiHooksLogFilePath, resetPiHooksLoggerForTests } from "../core/logger.js"
import { createHooksRuntime } from "../core/runtime.js"
import type { BashExecutionRequest, BashHookResult } from "../core/bash-types.js"
import type { HookAction, HookMap, HostAdapter } from "../core/types.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

function buildHookMap(actions: HookAction[], event: string, conditions?: unknown[]): HookMap {
  const hooks: HookMap = new Map()
  hooks.set(event as HookMap extends Map<infer K, unknown> ? K : never, [
    {
      id: "test-hook",
      event: event as HookMap extends Map<infer K, unknown> ? K : never,
      actions,
      ...(conditions ? { conditions: conditions as never } : {}),
      scope: "all",
      runIn: "current",
      source: { filePath: "/virtual/hooks.yaml", index: 0 },
    },
  ])
  return hooks
}

function createFakeHost(): HostAdapter {
  return {
    abort: () => {},
    getRootSessionId: (id) => id,
    runBash: async (req: BashExecutionRequest): Promise<BashHookResult> => ({
      command: req.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      blocking: false,
      status: "success",
      durationMs: 0,
      signal: null,
    }),
    sendPrompt: () => {},
    notify: () => {},
    confirm: async () => true,
    setStatus: () => {},
  }
}

async function withDebugLog<T>(run: (logFile: string) => Promise<T>): Promise<T> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-hooks-logging-"))
  const logFile = path.join(tempDir, "pi-hooks.ndjson")
  const previousDebug = process.env.PI_HOOKS_DEBUG
  const previousLogFile = process.env.PI_HOOKS_LOG_FILE
  process.env.PI_HOOKS_DEBUG = "1"
  process.env.PI_HOOKS_LOG_FILE = logFile
  resetPiHooksLoggerForTests()

  try {
    mkdirSync(tempDir, { recursive: true })
    return await run(logFile)
  } finally {
    if (previousDebug === undefined) {
      delete process.env.PI_HOOKS_DEBUG
    } else {
      process.env.PI_HOOKS_DEBUG = previousDebug
    }

    if (previousLogFile === undefined) {
      delete process.env.PI_HOOKS_LOG_FILE
    } else {
      process.env.PI_HOOKS_LOG_FILE = previousLogFile
    }
    resetPiHooksLoggerForTests()
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function readLogLines(logFile: string): string[] {
  const resolved = getPiHooksLogFilePath()
  if (resolved !== logFile) {
    throw new Error(`logger resolved unexpected path ${resolved} != ${logFile}`)
  }
  return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
}

const cases: Case[] = [
  {
    name: "logs exact follow-up prompt for tool actions",
    run: async () => withDebugLog(async (logFile) => {
      const runtime = createHooksRuntime(createFakeHost(), {
        directory: "/repo",
        hooks: buildHookMap(
          [
            {
              tool: {
                name: "read",
                args: { path: "/Users/tester/.pi/agent/skills/writer/SKILL.md" },
              },
            },
          ],
          "session.idle",
          [{ matchesAnyPath: ["README.md"] }],
        ),
      })

      await runtime["tool.execute.after"]({
        tool: "edit",
        sessionID: "s1",
        callID: "c1",
        args: { path: "README.md" },
      })
      await runtime.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

      const lines = readLogLines(logFile)
      const hit = lines.find((line) => line.includes("Tool action queued a follow-up prompt") && line.includes("writer/SKILL.md"))
      return hit ? { ok: true } : { ok: false, detail: `lines=${JSON.stringify(lines)}` }
    }),
  },
  {
    name: "logs hook skip reason when matchesAnyPath fails",
    run: async () => withDebugLog(async (logFile) => {
      const runtime = createHooksRuntime(createFakeHost(), {
        directory: "/repo",
        hooks: buildHookMap(
          [{ notify: "hi" }],
          "session.idle",
          [{ matchesAnyPath: ["README.md"] }],
        ),
      })

      await runtime["tool.execute.after"]({
        tool: "edit",
        sessionID: "s1",
        callID: "c1",
        args: { path: "docs/guide.md" },
      })
      await runtime.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

      const lines = readLogLines(logFile)
      const hit = lines.find((line) => line.includes("hook_skip") && line.includes("matchesAnyPath_failed"))
      return hit ? { ok: true } : { ok: false, detail: `lines=${JSON.stringify(lines)}` }
    }),
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
  /logging\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}

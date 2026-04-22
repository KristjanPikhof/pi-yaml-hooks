import { buildPathMatchContext, createHooksRuntime } from "./runtime.js"
import type { BashExecutionRequest, BashHookResult } from "./bash-types.js"
import type { HookAction, HookMap, HostAdapter } from "./types.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

function buildHookMap(actions: HookAction[], event: string, conditions?: unknown[]): HookMap {
  const hooks: HookMap = new Map()
  hooks.set(event as HookMap extends Map<infer K, unknown> ? K : never, [
    {
      id: "path-test-hook",
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

function createFakeHost(records: string[]): HostAdapter {
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
    notify: (text) => {
      records.push(text)
    },
    confirm: async () => true,
    setStatus: () => {},
  }
}

function createDelayedNotifyHost(records: string[], delayMs: number): HostAdapter {
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
    notify: async (text) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      records.push(text)
    },
    confirm: async () => true,
    setStatus: () => {},
  }
}

const cases: Case[] = [
  {
    name: "buildPathMatchContext normalizes change paths once per dispatch shape",
    run: async () => {
      const context = buildPathMatchContext("/repo", {
        changes: [
          { operation: "modify", path: "/repo/src/app.ts" },
          { operation: "rename", fromPath: "/repo/docs/old.md", toPath: "/repo/docs/new.md" },
        ],
      })

      return JSON.stringify(context.changedPaths) === JSON.stringify(["src/app.ts", "docs/new.md"]) && context.hasCodeFiles
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(context) }
    },
  },
  {
    name: "precomputed path context preserves matchesAnyPath and matchesAllPaths behavior",
    run: async () => {
      const records: string[] = []
      const runtime = createHooksRuntime(createFakeHost(records), {
        directory: "/repo",
        hooks: buildHookMap(
          [{ notify: "matched" }],
          "tool.after.write",
          [{ matchesAnyPath: ["src/**/*.ts"] }, { matchesAllPaths: ["src/**", "docs/**"] }],
        ),
      })

      await runtime["tool.execute.after"]({
        tool: "write",
        sessionID: "s1",
        callID: "c1",
        args: { path: "/repo/src/feature/file.ts", content: "ok" },
      })

      return JSON.stringify(records) === JSON.stringify(["matched"])
        ? { ok: true }
        : { ok: false, detail: `records=${JSON.stringify(records)}` }
    },
  },
  {
    name: "precomputed path context preserves matchesCodeFiles behavior for multi-file changes",
    run: async () => {
      const records: string[] = []
      const runtime = createHooksRuntime(createFakeHost(records), {
        directory: "/repo",
        hooks: buildHookMap([{ notify: "code-file-match" }], "session.idle", ["matchesCodeFiles"]),
      })

      await runtime.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      })
      if (records.length !== 0) {
        return { ok: false, detail: `unexpected initial records=${JSON.stringify(records)}` }
      }

      await runtime["tool.execute.after"]({
        tool: "edit",
        sessionID: "s1",
        callID: "c2",
        args: { path: "/repo/README.md", oldString: "a", newString: "b" },
      })
      await runtime["tool.execute.after"]({
        tool: "write",
        sessionID: "s1",
        callID: "c3",
        args: { path: "/repo/src/main.ts", content: "export {}" },
      })
      await runtime.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      })

      return JSON.stringify(records) === JSON.stringify(["code-file-match"])
        ? { ok: true }
        : { ok: false, detail: `records=${JSON.stringify(records)}` }
    },
  },
  {
    name: "queued dispatches compute path match context per request",
    run: async () => {
      const records: string[] = []
      const runtime = createHooksRuntime(createDelayedNotifyHost(records, 25), {
        directory: "/repo",
        hooks: buildHookMap([{ notify: "queued-match" }], "tool.after.write", [{ matchesAnyPath: ["src/**"] }]),
      })

      await Promise.all([
        runtime["tool.execute.after"]({
          tool: "write",
          sessionID: "s1",
          callID: "c4",
          args: { path: "/repo/docs/readme.md", content: "docs" },
        }),
        runtime["tool.execute.after"]({
          tool: "write",
          sessionID: "s1",
          callID: "c5",
          args: { path: "/repo/src/queued.ts", content: "code" },
        }),
      ])

      return JSON.stringify(records) === JSON.stringify(["queued-match"])
        ? { ok: true }
        : { ok: false, detail: `records=${JSON.stringify(records)}` }
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
  /runtime-paths\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}

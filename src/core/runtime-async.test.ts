import { loadDiscoveredHooks, parseHooksFile } from "./load-hooks.js"
import { createHooksRuntime } from "./runtime.js"
import type { BashExecutionRequest, BashHookResult } from "./bash-types.js"
import type { HookMap, HostAdapter } from "./types.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

const cases: Case[] = [
  {
    name: "parser accepts async group and concurrency settings",
    run: async () => {
      const parsed = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:
  - event: tool.after.write
    async:
      group: io
      concurrency: 2
    actions:
      - bash: "echo ok"
`,
      )

      return parsed.errors.length === 0
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(parsed.errors) }
    },
  },
  {
    name: "parser rejects async concurrency without a named group",
    run: async () => {
      const filePath = "/home/tester/.pi/agent/hook/hooks.yaml"
      const loaded = loadDiscoveredHooks({
        homeDir: "/home/tester",
        projectDir: "/repo",
        exists: (candidate) => candidate === filePath,
        readFile: () => `hooks:
  - event: tool.after.write
    async:
      concurrency: 2
    actions:
      - bash: "echo ok"
`,
      })

      return loaded.errors.some((error) => error.code === "invalid_async" && /requires async\.group/i.test(error.message))
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(loaded.errors) }
    },
  },
  {
    name: "parser rejects conflicting concurrency in the same async group",
    run: async () => {
      const filePath = "/home/tester/.pi/agent/hook/hooks.yaml"
      const loaded = loadDiscoveredHooks({
        homeDir: "/home/tester",
        projectDir: "/repo",
        exists: (candidate) => candidate === filePath,
        readFile: () => `hooks:
  - event: tool.after.write
    async:
      group: uploads
      concurrency: 2
    actions:
      - bash: "echo one"
  - event: tool.after.write
    async:
      group: uploads
      concurrency: 3
    actions:
      - bash: "echo two"
`,
      })

      return loaded.errors.some((error) => error.code === "invalid_async" && /must match earlier hooks/i.test(error.message))
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(loaded.errors) }
    },
  },
  {
    name: "default async behavior remains serialized per event and session",
    run: async () => {
      const activeCounts: number[] = []
      let active = 0
      const hooks = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:
  - id: first
    event: tool.after.write
    async: true
    actions:
      - bash: "job:first"
  - id: second
    event: tool.after.write
    async: true
    actions:
      - bash: "job:second"
`,
      ).hooks as HookMap
      const runtime = createHooksRuntime(createFakeHost(), {
        directory: "/repo",
        hooks,
        executeBash: async (request: BashExecutionRequest): Promise<BashHookResult> => {
          active += 1
          activeCounts.push(active)
          await sleep(20)
          active -= 1
          return {
            command: request.command,
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            blocking: false,
            status: "success",
            durationMs: 20,
            signal: null,
          }
        },
      })

      await runtime["tool.execute.after"]({
        tool: "write",
        sessionID: "s1",
        callID: "c1",
        args: { path: "/repo/file.txt", content: "ok" },
      })
      await sleep(70)

      return Math.max(...activeCounts, 0) === 1
        ? { ok: true }
        : { ok: false, detail: `activeCounts=${JSON.stringify(activeCounts)}` }
    },
  },
  {
    name: "named async groups run independently",
    run: async () => {
      const timeline: string[] = []
      let active = 0
      let maxActive = 0
      const hooks = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:
  - id: group-a
    event: tool.after.write
    async:
      group: lint
    actions:
      - bash: "job:lint"
  - id: group-b
    event: tool.after.write
    async:
      group: notify
    actions:
      - bash: "job:notify"
`,
      ).hooks as HookMap
      const runtime = createHooksRuntime(createFakeHost(), {
        directory: "/repo",
        hooks,
        executeBash: async (request: BashExecutionRequest): Promise<BashHookResult> => {
          active += 1
          maxActive = Math.max(maxActive, active)
          timeline.push(`start:${request.command}`)
          await sleep(20)
          timeline.push(`end:${request.command}`)
          active -= 1
          return {
            command: request.command,
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            blocking: false,
            status: "success",
            durationMs: 20,
            signal: null,
          }
        },
      })

      await runtime["tool.execute.after"]({
        tool: "write",
        sessionID: "s1",
        callID: "c1",
        args: { path: "/repo/file.txt", content: "ok" },
      })
      await sleep(70)

      return maxActive >= 2
        ? { ok: true }
        : { ok: false, detail: `timeline=${JSON.stringify(timeline)}` }
    },
  },
  {
    name: "bounded async concurrency allows more than one in a group",
    run: async () => {
      const activeCounts: number[] = []
      let active = 0
      const hooks = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:
  - id: one
    event: tool.after.write
    async:
      group: uploads
      concurrency: 2
    actions:
      - bash: "job:one"
  - id: two
    event: tool.after.write
    async:
      group: uploads
      concurrency: 2
    actions:
      - bash: "job:two"
  - id: three
    event: tool.after.write
    async:
      group: uploads
      concurrency: 2
    actions:
      - bash: "job:three"
`,
      ).hooks as HookMap
      const runtime = createHooksRuntime(createFakeHost(), {
        directory: "/repo",
        hooks,
        executeBash: async (request: BashExecutionRequest): Promise<BashHookResult> => {
          active += 1
          activeCounts.push(active)
          await sleep(20)
          active -= 1
          return {
            command: request.command,
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            blocking: false,
            status: "success",
            durationMs: 20,
            signal: null,
          }
        },
      })

      await runtime["tool.execute.after"]({
        tool: "write",
        sessionID: "s1",
        callID: "c1",
        args: { path: "/repo/file.txt", content: "ok" },
      })
      await sleep(90)

      return Math.max(...activeCounts, 0) === 2
        ? { ok: true }
        : { ok: false, detail: `activeCounts=${JSON.stringify(activeCounts)}` }
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
  /runtime-async\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}

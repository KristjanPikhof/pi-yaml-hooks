import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { resetPiHooksLoggerForTests } from "../core/logger.js"
import piHooksExtension from "../index.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

type PiHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown
type CommandHandler = (args: string, ctx: unknown) => Promise<void>

class FakePiHarness {
  readonly projectDir: string
  readonly notifications: string[] = []
  readonly statusUpdates: Array<{ hookId: string; text?: string }> = []
  readonly confirms: Array<{ title: string; message: string }> = []
  readonly userMessages: Array<{ text: string; options?: unknown }> = []
  readonly handlers = new Map<string, PiHandler>()
  readonly commands = new Map<string, CommandHandler>()
  readonly sessionId: string
  hasUI = true
  confirmResult = true
  reloads = 0
  notificationsWithLevel: Array<{ message: string; type?: string }> = []

  constructor(projectDir: string, sessionId = "session-1") {
    this.projectDir = projectDir
    this.sessionId = sessionId
  }

  register(): void {
    const pi = {
      on: (event: string, handler: PiHandler) => {
        this.handlers.set(event, handler)
      },
      registerCommand: (name: string, options: { handler: CommandHandler }) => {
        this.commands.set(name, options.handler)
      },
      sendUserMessage: (text: string, options?: unknown) => {
        this.userMessages.push({ text, options })
      },
    } as unknown as Parameters<typeof piHooksExtension>[0]

    piHooksExtension(pi)
  }

  createContext(): unknown {
    return {
      cwd: this.projectDir,
      hasUI: this.hasUI,
      ui: this.hasUI
        ? {
            notify: (text: string, type?: string) => {
              this.notifications.push(text)
              this.notificationsWithLevel.push({ message: text, type })
            },
            confirm: async (title: string, message: string) => {
              this.confirms.push({ title, message })
              return this.confirmResult
            },
            setStatus: (hookId: string, text?: string) => {
              this.statusUpdates.push({ hookId, text })
            },
          }
        : undefined,
      sessionManager: {
        getSessionId: () => this.sessionId,
        getHeader: () => ({}),
      },
      isIdle: () => true,
      hasPendingMessages: () => false,
      reload: async () => {
        this.reloads += 1
      },
    } as never
  }

  async emit(eventName: string, event: unknown = {}): Promise<unknown> {
    const handler = this.handlers.get(eventName)
    if (!handler) {
      throw new Error(`${eventName} handler was not registered`)
    }

    return await handler(event, this.createContext())
  }

  async sessionStart(reason: "new" | "startup" | "resume" = "new"): Promise<void> {
    await this.emit("session_start", { reason })
  }

  async agentEnd(): Promise<void> {
    await this.emit("agent_end")
  }

  async toolCall(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): Promise<unknown> {
    return await this.emit("tool_call", { toolName, toolCallId, input })
  }

  async toolResult(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): Promise<void> {
    await this.emit("tool_result", { toolName, toolCallId, input })
  }

  async command(name: string, args = ""): Promise<void> {
    const handler = this.commands.get(name)
    if (!handler) {
      throw new Error(`${name} command was not registered`)
    }

    await handler(args, this.createContext())
  }
}

function writeProjectHooks(projectDir: string, content: string): void {
  const filePath = path.join(projectDir, ".pi", "hook", "hooks.yaml")
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

function withTrust<T>(trusted: boolean, run: () => Promise<T>): Promise<T> {
  const previousTrust = process.env.PI_HOOKS_TRUST_PROJECT
  if (trusted) process.env.PI_HOOKS_TRUST_PROJECT = "1"
  else delete process.env.PI_HOOKS_TRUST_PROJECT
  return run().finally(() => {
    if (previousTrust === undefined) delete process.env.PI_HOOKS_TRUST_PROJECT
    else process.env.PI_HOOKS_TRUST_PROJECT = previousTrust
  })
}

async function withIsolatedProject<T>(trusted: boolean, run: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "pi-hooks-adapter-"))
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "pi-hooks-home-"))
  const previousWarn = console.warn
  const previousInfo = console.info
  const previousError = console.error
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  resetPiHooksLoggerForTests()
  console.warn = () => {}
  console.info = () => {}
  console.error = () => {}

  return withTrust(trusted, async () => {
    try {
      return await run(projectDir)
    } finally {
      console.warn = previousWarn
      console.info = previousInfo
      console.error = previousError
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      resetPiHooksLoggerForTests()
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
}

function readTrustedProjectsFile(): string[] {
  const filePath = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".pi", "agent", "trusted-projects.json")
  if (!existsSync(filePath)) {
    return []
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as string[]
}

const cases: Case[] = [
  {
    name: "trusted project hooks load through PI session lifecycle events",
    run: async () =>
      await withIsolatedProject(true, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.created
    actions:
      - notify: "trusted-created"
  - event: session.idle
    actions:
      - notify: "trusted-idle"
`,
        )

        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.sessionStart("new")
        await harness.agentEnd()

        const expected = JSON.stringify(["trusted-created", "trusted-idle"])
        return JSON.stringify(harness.notifications) === expected
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(harness.notifications)}` }
      }),
  },
  {
    name: "untrusted project hooks do not load through the lifecycle harness",
    run: async () =>
      await withIsolatedProject(false, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.created
    actions:
      - notify: "should-not-run"
  - event: session.idle
    actions:
      - notify: "should-not-run"
`,
        )

        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.sessionStart("new")
        await harness.agentEnd()

        return harness.notifications.length === 0
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(harness.notifications)}` }
      }),
  },
  {
    name: "tool actions queue PI follow-up prompts through sendUserMessage",
    run: async () =>
      await withIsolatedProject(true, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: tool.after.write
    actions:
      - tool:
          name: grep
          args:
            pattern: TODO
            path: src
`,
        )

        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.toolResult("write", "call-1", { path: path.join(projectDir, "src", "file.ts"), content: "ok" })

        if (harness.userMessages.length !== 1) {
          return { ok: false, detail: `userMessages=${JSON.stringify(harness.userMessages)}` }
        }

        const [{ text, options }] = harness.userMessages
        return text.includes("Use the grep tool") && JSON.stringify(options) === JSON.stringify({ deliverAs: "followUp" })
          ? { ok: true }
          : { ok: false, detail: `userMessages=${JSON.stringify(harness.userMessages)}` }
      }),
  },
  {
    name: "headless confirm denies tool execution by default",
    run: async () =>
      await withIsolatedProject(true, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: tool.before.bash
    actions:
      - confirm:
          title: "Approval required"
          message: "Run command?"
`,
        )

        const harness = new FakePiHarness(projectDir)
        harness.hasUI = false
        harness.register()
        const result = await harness.toolCall("bash", "call-2", { command: "echo hi" })

        return result &&
            typeof result === "object" &&
            "block" in result &&
            result.block === true &&
            "reason" in result &&
            typeof result.reason === "string" &&
            /confirm/i.test(result.reason) &&
            harness.confirms.length === 0
          ? { ok: true }
          : { ok: false, detail: `result=${JSON.stringify(result)}, confirms=${JSON.stringify(harness.confirms)}` }
      }),
  },
  {
    name: "edited hooks reload through PI events and invalid edits keep last known good config",
    run: async () =>
      await withIsolatedProject(true, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: "idle-v1"
`,
        )

        const harness = new FakePiHarness(projectDir)
        harness.register()

        await harness.agentEnd()

        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: "idle-v2"
`,
        )
        await harness.toolResult("edit", "call-3", { path: path.join(projectDir, ".pi", "hook", "hooks.yaml") })
        await harness.agentEnd()

        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify:
`,
        )
        await harness.toolResult("edit", "call-4", { path: path.join(projectDir, ".pi", "hook", "hooks.yaml") })
        await harness.agentEnd()

        const expected = JSON.stringify(["idle-v1", "idle-v2", "idle-v2"])
        return JSON.stringify(harness.notifications) === expected
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(harness.notifications)}` }
      }),
  },
  {
    name: "edited imported hooks reload through PI events and invalid imported edits keep last known good config",
    run: async () =>
      await withIsolatedProject(true, async (projectDir) => {
        const importedPath = path.join(projectDir, ".pi", "hook", "imports", "session-idle.yaml")
        mkdirSync(path.dirname(importedPath), { recursive: true })
        writeFileSync(
          path.join(projectDir, ".pi", "hook", "hooks.yaml"),
          `imports:
  - ./imports/session-idle.yaml
hooks: []
`,
          "utf8",
        )
        writeFileSync(
          importedPath,
          `hooks:
  - event: session.idle
    actions:
      - notify: "import-v1"
`,
          "utf8",
        )

        const harness = new FakePiHarness(projectDir)
        harness.register()

        await harness.agentEnd()

        writeFileSync(
          importedPath,
          `hooks:
  - event: session.idle
    actions:
      - notify: "import-v2"
`,
          "utf8",
        )
        await harness.toolResult("edit", "call-import-1", { path: importedPath })
        await harness.agentEnd()

        writeFileSync(
          importedPath,
          `hooks:
  - event: session.idle
    actions:
      - notify:
`,
          "utf8",
        )
        await harness.toolResult("edit", "call-import-2", { path: importedPath })
        await harness.agentEnd()

        const expected = JSON.stringify(["import-v1", "import-v2", "import-v2"])
        return JSON.stringify(harness.notifications) === expected
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(harness.notifications)}` }
      }),
  },
  {
    name: "hooks-status command reports active hooks and trust state",
    run: async () =>
      await withIsolatedProject(true, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: "idle"
`,
        )

        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.command("hooks-status")

        return harness.notifications.some((message) => message.includes("Project trusted: yes")) &&
            harness.notifications.some((message) => message.includes("Active summary:"))
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(harness.notifications)}` }
      }),
  },
  {
    name: "hooks-status does not claim project hooks exist when no project file is present",
    run: async () =>
      await withIsolatedProject(false, async (projectDir) => {
        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.command("hooks-status")

        return harness.notifications.some((message) => message.includes(`Project config: ${projectDir}/.pi/hook/hooks.yaml (missing)`)) &&
            harness.notifications.every((message) => !message.includes("Project hooks exist but are not active"))
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(harness.notifications)}` }
      }),
  },
  {
    name: "hooks-validate command explains untrusted project hooks",
    run: async () =>
      await withIsolatedProject(false, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: "idle"
`,
        )

        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.command("hooks-validate")

        return harness.notifications.some((message) => message.includes("valid but untrusted")) &&
            harness.notifications.some((message) => message.includes("/hooks-trust"))
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(harness.notifications)}` }
      }),
  },
  {
    name: "hooks-trust command writes the current project to trusted-projects.json",
    run: async () =>
      await withIsolatedProject(false, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: "idle"
`,
        )
        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.command("hooks-trust")

        const trustedProjects = readTrustedProjectsFile()
        return trustedProjects.includes(realpathSync.native(projectDir))
          ? { ok: true }
          : { ok: false, detail: `trustedProjects=${JSON.stringify(trustedProjects)}` }
      }),
  },
  {
    name: "hooks-trust warns when no project hook file exists",
    run: async () =>
      await withIsolatedProject(false, async (projectDir) => {
        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.command("hooks-trust")

        return harness.notifications.some((message) => message.includes("No project hook file was found")) &&
            readTrustedProjectsFile().length === 0
          ? { ok: true }
          : {
              ok: false,
              detail: `notifications=${JSON.stringify(harness.notifications)}, trusted=${JSON.stringify(readTrustedProjectsFile())}`,
            }
      }),
  },
  {
    name: "hooks-trust refuses to overwrite malformed trusted-projects.json",
    run: async () =>
      await withIsolatedProject(false, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: "idle"
`,
        )
        const trustFile = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".pi", "agent", "trusted-projects.json")
        mkdirSync(path.dirname(trustFile), { recursive: true })
        writeFileSync(trustFile, "{not-json", "utf8")

        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.command("hooks-trust")

        return harness.notifications.some((message) => message.includes("not valid JSON")) &&
            readFileSync(trustFile, "utf8") === "{not-json"
          ? { ok: true }
          : {
              ok: false,
              detail: `notifications=${JSON.stringify(harness.notifications)}, trustFile=${JSON.stringify(readFileSync(trustFile, "utf8"))}`,
            }
      }),
  },
  {
    name: "hooks-trust dedupes an existing symlinked trust anchor",
    run: async () =>
      await withIsolatedProject(false, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: "idle"
`,
        )
        const symlinkDir = `${projectDir}-alias`
        symlinkSync(projectDir, symlinkDir)
        const trustFile = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".pi", "agent", "trusted-projects.json")
        mkdirSync(path.dirname(trustFile), { recursive: true })
        writeFileSync(trustFile, JSON.stringify([symlinkDir], null, 2) + "\n", "utf8")

        try {
          const harness = new FakePiHarness(projectDir)
          harness.register()
          await harness.command("hooks-trust")

          const trustedProjects = readTrustedProjectsFile()
          return trustedProjects.length === 1 && trustedProjects[0] === symlinkDir
            ? { ok: true }
            : { ok: false, detail: `trustedProjects=${JSON.stringify(trustedProjects)}` }
        } finally {
          rmSync(symlinkDir, { force: true })
        }
      }),
  },
  {
    name: "hooks-reload command triggers PI extension reload",
    run: async () =>
      await withIsolatedProject(true, async (projectDir) => {
        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.command("hooks-reload")

        return harness.reloads === 1
          ? { ok: true }
          : { ok: false, detail: `reloads=${harness.reloads}` }
      }),
  },
  {
    name: "hooks-tail-log command shows the tail command",
    run: async () =>
      await withIsolatedProject(true, async (projectDir) => {
        const harness = new FakePiHarness(projectDir)
        harness.register()
        await harness.command("hooks-tail-log")

        return harness.notifications.some((message) => message.includes("tail -F"))
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(harness.notifications)}` }
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
  /adapter\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}

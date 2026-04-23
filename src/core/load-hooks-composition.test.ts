import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { loadDiscoveredHooks, parseHooksFile } from "./load-hooks.js"

interface Case {
  readonly name: string
  readonly run: () => { ok: boolean; detail?: string }
}

function createSandbox(name: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `pi-hooks-${name}-`))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function writeYaml(filePath: string, content: string): string {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
  return filePath
}

function loadFrom(globalPath: string | undefined, projectPath: string | undefined, homeDir: string, projectDir?: string) {
  return loadDiscoveredHooks({
    homeDir,
    projectDir,
    exists: (filePath) => [globalPath, projectPath].includes(filePath),
    readFile: (filePath) => {
      throw new Error(`unexpected config-path read for ${filePath}`)
    },
  })
}

function loadTrustedProject(projectRoot: string, homeDir: string) {
  writeYaml(path.join(homeDir, ".pi", "agent", "trusted-projects.json"), JSON.stringify([projectRoot]))
  return loadDiscoveredHooks({ homeDir, projectDir: projectRoot })
}

function getHookIds(result: ReturnType<typeof loadDiscoveredHooks>, event: string): string[] {
  return (result.hooks.get(event as never) ?? []).map((hook) => hook.id ?? "<none>")
}

const cases: Case[] = [
  {
    name: "import chain order is base then package then root",
    run: () => {
      const sandbox = createSandbox("import-order")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        const packageRoot = path.join(projectRoot, "node_modules", "hook-pack")
        writeYaml(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "hook-pack", version: "1.0.0", main: "hooks.yaml" }, null, 2),
        )
        writeYaml(
          path.join(packageRoot, "hooks.yaml"),
          `hooks:\n  - id: package-layer\n    override: base-layer\n    event: session.created\n    actions:\n      - notify: package\n`,
        )
        writeYaml(
          path.join(projectRoot, "shared", "base.yaml"),
          `hooks:\n  - id: base-layer\n    event: session.created\n    actions:\n      - notify: base\n`,
        )
        writeYaml(
          path.join(projectRoot, ".pi", "hook", "hooks.yaml"),
          `imports:\n  - ../../shared/base.yaml\n  - hook-pack\nhooks:\n  - id: root-layer\n    override: package-layer\n    event: session.created\n    actions:\n      - notify: root\n`,
        )

        const result = loadTrustedProject(projectRoot, homeDir)
        const hooks = result.hooks.get("session.created") ?? []
        const notify = hooks[0]?.actions[0]
        return hooks.length === 1 && hooks[0]?.id === "root-layer" && notify && "notify" in notify && notify.notify === "root"
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ ids: getHookIds(result, "session.created"), errors: result.errors, files: result.files }) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "disable can target imported hook",
    run: () => {
      const sandbox = createSandbox("disable-import")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        writeYaml(path.join(projectRoot, "shared", "base.yaml"), `hooks:\n  - id: imported\n    event: session.created\n    actions:\n      - notify: base\n`)
        writeYaml(
          path.join(projectRoot, ".pi", "hook", "hooks.yaml"),
          `imports:\n  - ../../shared/base.yaml\nhooks:\n  - override: imported\n    disable: true\n`,
        )

        const result = loadTrustedProject(projectRoot, homeDir)
        return (result.hooks.get("session.created") ?? []).length === 0 && result.errors.length === 0
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ hooks: getHookIds(result, "session.created"), errors: result.errors }) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "directory imports expand in lexical order",
    run: () => {
      const sandbox = createSandbox("dir-import")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        writeYaml(path.join(projectRoot, "shared", "hooks.d", "20-second.yaml"), `hooks:\n  - id: second\n    event: session.created\n    actions:\n      - notify: second\n`)
        writeYaml(path.join(projectRoot, "shared", "hooks.d", "10-first.yaml"), `hooks:\n  - id: first\n    event: session.created\n    actions:\n      - notify: first\n`)
        writeYaml(path.join(projectRoot, ".pi", "hook", "hooks.yaml"), `imports:\n  - ../../shared/hooks.d\nhooks: []\n`)

        const result = loadTrustedProject(projectRoot, homeDir)
        const ids = getHookIds(result, "session.created")
        return JSON.stringify(ids) === JSON.stringify(["first", "second"]) ? { ok: true } : { ok: false, detail: JSON.stringify(ids) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "package-backed imports resolve through node modules",
    run: () => {
      const sandbox = createSandbox("pkg-import")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        const packageRoot = path.join(projectRoot, "node_modules", "hook-pack")
        writeYaml(path.join(packageRoot, "package.json"), JSON.stringify({ name: "hook-pack", version: "1.0.0", main: "hooks.yaml" }, null, 2))
        writeYaml(path.join(packageRoot, "hooks.yaml"), `hooks:\n  - id: packaged\n    event: session.created\n    actions:\n      - notify: packaged\n`)
        writeYaml(path.join(projectRoot, ".pi", "hook", "hooks.yaml"), `imports:\n  - hook-pack\nhooks: []\n`)

        const result = loadTrustedProject(projectRoot, homeDir)
        return JSON.stringify(getHookIds(result, "session.created")) === JSON.stringify(["packaged"])
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ files: result.files, errors: result.errors }) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "cycles produce invalid_imports error",
    run: () => {
      const sandbox = createSandbox("cycle")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        writeYaml(path.join(projectRoot, "shared", "a.yaml"), `imports:\n  - ./b.yaml\nhooks: []\n`)
        writeYaml(path.join(projectRoot, "shared", "b.yaml"), `imports:\n  - ./a.yaml\nhooks: []\n`)
        writeYaml(path.join(projectRoot, ".pi", "hook", "hooks.yaml"), `imports:\n  - ../../shared/a.yaml\nhooks: []\n`)

        const result = loadTrustedProject(projectRoot, homeDir)
        return result.errors.some((error) => error.code === "invalid_imports" && error.message.includes("cycle"))
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(result.errors) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "duplicate imports are deduped by canonical path",
    run: () => {
      const sandbox = createSandbox("dedupe")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        writeYaml(path.join(projectRoot, "shared", "leaf.yaml"), `hooks:\n  - id: leaf\n    event: session.created\n    actions:\n      - notify: leaf\n`)
        writeYaml(path.join(projectRoot, "shared", "a.yaml"), `imports:\n  - ./leaf.yaml\nhooks: []\n`)
        writeYaml(path.join(projectRoot, "shared", "b.yaml"), `imports:\n  - ./leaf.yaml\nhooks: []\n`)
        writeYaml(path.join(projectRoot, ".pi", "hook", "hooks.yaml"), `imports:\n  - ../../shared/a.yaml\n  - ../../shared/b.yaml\nhooks: []\n`)

        const result = loadTrustedProject(projectRoot, homeDir)
        const occurrences = result.files.filter((filePath) => filePath.endsWith("leaf.yaml")).length
        return occurrences === 1 && JSON.stringify(getHookIds(result, "session.created")) === JSON.stringify(["leaf"])
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ files: result.files, ids: getHookIds(result, "session.created") }) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "untrusted project root still blocks imported hooks",
    run: () => {
      const sandbox = createSandbox("trust")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        writeYaml(path.join(projectRoot, "shared", "leaf.yaml"), `hooks:\n  - id: leaf\n    event: session.created\n    actions:\n      - notify: leaf\n`)
        const rootPath = writeYaml(path.join(projectRoot, ".pi", "hook", "hooks.yaml"), `imports:\n  - ../../shared/leaf.yaml\nhooks: []\n`)

        const result = loadDiscoveredHooks({ homeDir, projectDir: projectRoot })
        return result.files.length === 0 && (result.hooks.get("session.created") ?? []).length === 0
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ rootPath, files: result.files, errors: result.errors }) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "missing imports surface invalid_imports error",
    run: () => {
      const sandbox = createSandbox("missing")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        writeYaml(path.join(projectRoot, ".pi", "hook", "hooks.yaml"), `imports:\n  - ../../shared/missing.yaml\nhooks: []\n`)

        const result = loadTrustedProject(projectRoot, homeDir)
        return result.errors.some((error) => error.code === "invalid_imports" && error.message.includes("missing.yaml"))
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(result.errors) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "path conditions are accepted on tool.after events",
    run: () => {
      const result = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:
  - id: path-filtered-write
    event: tool.after.write
    conditions:
      - matchesAnyPath:
          - "src/**"
      - matchesAllPaths: "**/*.ts"
    actions:
      - notify: "matched"
`,
      )

      const hooks = result.hooks.get("tool.after.write") ?? []
      return result.errors.length === 0 && hooks.length === 1
        ? { ok: true }
        : { ok: false, detail: JSON.stringify({ errors: result.errors, hooks: hooks.length }) }
    },
  },
  {
    name: "path conditions stay rejected on tool.before events",
    run: () => {
      const result = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:
  - id: before-path-filter
    event: tool.before.write
    conditions:
      - matchesAnyPath: "src/**"
    actions:
      - notify: "matched"
`,
      )

      return result.errors.some((error) => error.code === "invalid_conditions" && error.path === "hooks[0].conditions[0].matchesAnyPath")
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(result.errors) }
    },
  },
  {
    name: "path conditions stay rejected on lifecycle events without changed paths",
    run: () => {
      const result = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:
  - id: created-path-filter
    event: session.created
    conditions:
      - matchesAllPaths: "src/**"
    actions:
      - notify: "matched"
`,
      )

      return result.errors.some((error) => error.code === "invalid_conditions" && error.path === "hooks[0].conditions[0].matchesAllPaths")
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(result.errors) }
    },
  },
]

export function main(): number {
  let failures = 0
  for (const c of cases) {
    try {
      const outcome = c.run()
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
  /load-hooks-composition\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  process.exit(main())
}

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

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {}
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key]
    const value = overrides[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    return fn()
  } finally {
    for (const key of Object.keys(original)) {
      const value = original[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
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

        const result = withEnv({ PI_HOOKS_ALLOW_PACKAGE_IMPORTS: "1" }, () => loadTrustedProject(projectRoot, homeDir))
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

        const result = withEnv({ PI_HOOKS_ALLOW_PACKAGE_IMPORTS: "1" }, () => loadTrustedProject(projectRoot, homeDir))
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
    name: "directory imports skip dotfiles and non-yaml entries",
    run: () => {
      const sandbox = createSandbox("dir-filter")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        const dir = path.join(projectRoot, "shared", "hooks.d")
        writeYaml(path.join(dir, "10-real.yaml"), `hooks:\n  - id: real\n    event: session.created\n    actions:\n      - notify: real\n`)
        // Non-yaml content that, if loaded, would fail to parse and surface errors.
        writeYaml(path.join(dir, ".DS_Store"), "binary garbage  not yaml\n")
        writeYaml(path.join(dir, ".hidden.yaml"), "this: is: not: valid yaml\n")
        writeYaml(path.join(dir, "README.md"), "# not a hook file\n")
        writeYaml(path.join(projectRoot, ".pi", "hook", "hooks.yaml"), `imports:\n  - ../../shared/hooks.d\nhooks: []\n`)

        const result = loadTrustedProject(projectRoot, homeDir)
        const ids = getHookIds(result, "session.created")
        const onlyRealLoaded = JSON.stringify(ids) === JSON.stringify(["real"])
        const noJunkInFiles = !result.files.some((file) => file.endsWith(".DS_Store") || file.endsWith("README.md") || file.endsWith(".hidden.yaml"))
        return onlyRealLoaded && noJunkInFiles && result.errors.length === 0
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ ids, files: result.files, errors: result.errors }) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "package imports refused without PI_HOOKS_ALLOW_PACKAGE_IMPORTS",
    run: () => {
      const sandbox = createSandbox("pkg-gate")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        const packageRoot = path.join(projectRoot, "node_modules", "hook-pack")
        writeYaml(path.join(packageRoot, "package.json"), JSON.stringify({ name: "hook-pack", version: "1.0.0", main: "hooks.yaml" }, null, 2))
        writeYaml(path.join(packageRoot, "hooks.yaml"), `hooks:\n  - id: packaged\n    event: session.created\n    actions:\n      - notify: packaged\n`)
        writeYaml(path.join(projectRoot, ".pi", "hook", "hooks.yaml"), `imports:\n  - hook-pack\nhooks: []\n`)

        const result = withEnv({ PI_HOOKS_ALLOW_PACKAGE_IMPORTS: undefined }, () => loadTrustedProject(projectRoot, homeDir))
        const refused = result.errors.some(
          (error) => error.code === "invalid_imports" && error.message.includes("[PIHOOKS]") && error.message.includes("PI_HOOKS_ALLOW_PACKAGE_IMPORTS"),
        )
        const notLoaded = (result.hooks.get("session.created") ?? []).length === 0
        return refused && notLoaded
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ errors: result.errors, ids: getHookIds(result, "session.created") }) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "global hooks file refuses imports without PI_HOOKS_ALLOW_GLOBAL_IMPORTS",
    run: () => {
      const sandbox = createSandbox("global-gate")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        writeYaml(path.join(homeDir, "shared", "leaf.yaml"), `hooks:\n  - id: leaf\n    event: session.created\n    actions:\n      - notify: leaf\n`)
        writeYaml(
          path.join(homeDir, ".pi", "agent", "hook", "hooks.yaml"),
          `imports:\n  - ../../../shared/leaf.yaml\nhooks: []\n`,
        )
        // Trust the project so we get a deterministic load path.
        writeYaml(path.join(homeDir, ".pi", "agent", "trusted-projects.json"), JSON.stringify([projectRoot]))

        const result = withEnv({ PI_HOOKS_ALLOW_GLOBAL_IMPORTS: undefined }, () =>
          loadDiscoveredHooks({ homeDir, projectDir: projectRoot }),
        )
        const refused = result.errors.some(
          (error) =>
            error.code === "invalid_imports" &&
            error.message.includes("[PIHOOKS]") &&
            error.message.includes("PI_HOOKS_ALLOW_GLOBAL_IMPORTS"),
        )
        const notLoaded = (result.hooks.get("session.created") ?? []).length === 0
        return refused && notLoaded
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ errors: result.errors, ids: getHookIds(result, "session.created") }) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "global imports load when PI_HOOKS_ALLOW_GLOBAL_IMPORTS=1",
    run: () => {
      const sandbox = createSandbox("global-allow")
      try {
        const homeDir = path.join(sandbox, "home")
        const projectRoot = path.join(sandbox, "project")
        writeYaml(path.join(homeDir, "shared", "leaf.yaml"), `hooks:\n  - id: global-leaf\n    event: session.created\n    actions:\n      - notify: leaf\n`)
        writeYaml(
          path.join(homeDir, ".pi", "agent", "hook", "hooks.yaml"),
          `imports:\n  - ../../../shared/leaf.yaml\nhooks: []\n`,
        )
        writeYaml(path.join(homeDir, ".pi", "agent", "trusted-projects.json"), JSON.stringify([projectRoot]))

        const result = withEnv({ PI_HOOKS_ALLOW_GLOBAL_IMPORTS: "1" }, () =>
          loadDiscoveredHooks({ homeDir, projectDir: projectRoot }),
        )
        const ids = getHookIds(result, "session.created")
        return JSON.stringify(ids) === JSON.stringify(["global-leaf"])
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ ids, errors: result.errors, files: result.files }) }
      } finally {
        cleanup(sandbox)
      }
    },
  },
  {
    name: "async rejects notify action",
    run: () => {
      const result = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:\n  - id: async-notify\n    event: tool.after.write\n    async: true\n    actions:\n      - notify: "done"\n`,
      )
      return result.errors.some(
        (error) => error.code === "invalid_async" && error.path === "hooks[0].async" && error.message.includes("notify"),
      ) && (result.hooks.get("tool.after.write") ?? []).length === 0
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(result.errors) }
    },
  },
  {
    name: "async rejects confirm action",
    run: () => {
      const result = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:\n  - id: async-confirm\n    event: tool.after.write\n    async: true\n    actions:\n      - confirm:\n          prompt: "ok?"\n`,
      )
      return result.errors.some(
        (error) => error.code === "invalid_async" && error.path === "hooks[0].async" && error.message.includes("confirm"),
      ) && (result.hooks.get("tool.after.write") ?? []).length === 0
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(result.errors) }
    },
  },
  {
    name: "async rejects setStatus action",
    run: () => {
      const result = parseHooksFile(
        "/virtual/hooks.yaml",
        `hooks:\n  - id: async-setstatus\n    event: tool.after.write\n    async: true\n    actions:\n      - setStatus: "watching"\n`,
      )
      return result.errors.some(
        (error) => error.code === "invalid_async" && error.path === "hooks[0].async" && error.message.includes("setStatus"),
      ) && (result.hooks.get("tool.after.write") ?? []).length === 0
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(result.errors) }
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

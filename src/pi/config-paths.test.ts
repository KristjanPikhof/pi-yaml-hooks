import { discoverHookConfigPaths } from "../core/config-paths.js"
import { formatHookLoadSummary, loadDiscoveredHooks } from "../core/load-hooks.js"

interface Case {
  readonly name: string
  readonly run: () => { ok: boolean; detail?: string }
}

const homeDir = "/Users/tester"
const projectDir = "/repo/pi-hooks"
const globalPiPath = `${homeDir}/.pi/agent/hooks.yaml`
const globalLegacyPath = `${homeDir}/.config/opencode/hook/hooks.yaml`
const projectPiPath = `${projectDir}/.pi/hooks.yaml`
const projectLegacyPath = `${projectDir}/.opencode/hook/hooks.yaml`

function withTrustedProject<T>(run: () => T): T {
  const previous = process.env.PI_HOOKS_TRUST_PROJECT
  process.env.PI_HOOKS_TRUST_PROJECT = "1"
  try {
    return run()
  } finally {
    if (previous === undefined) {
      delete process.env.PI_HOOKS_TRUST_PROJECT
    } else {
      process.env.PI_HOOKS_TRUST_PROJECT = previous
    }
  }
}

const cases: Case[] = [
  {
    name: "discovers only PI-native global + project paths",
    run: () => withTrustedProject(() => {
      const existing = new Set([globalPiPath, globalLegacyPath, projectPiPath, projectLegacyPath])
      const paths = discoverHookConfigPaths({
        homeDir,
        projectDir,
        exists: (filePath) => existing.has(filePath),
      })

      const expected = [globalPiPath, projectPiPath]
      return JSON.stringify(paths) === JSON.stringify(expected)
        ? { ok: true }
        : { ok: false, detail: `paths=${JSON.stringify(paths)}` }
    }),
  },
  {
    name: "ignores legacy-only OpenCode paths",
    run: () => withTrustedProject(() => {
      const existing = new Set([globalLegacyPath, projectLegacyPath])
      const paths = discoverHookConfigPaths({
        homeDir,
        projectDir,
        exists: (filePath) => existing.has(filePath),
      })

      return paths.length === 0
        ? { ok: true }
        : { ok: false, detail: `paths=${JSON.stringify(paths)}` }
    }),
  },
  {
    name: "formats startup summary with global + project hook counts",
    run: () => withTrustedProject(() => {
      const existing = new Set([globalPiPath, projectPiPath])
      const files = new Map<string, string>([
        [globalPiPath, `hooks:\n  - event: session.idle\n    actions:\n      - notify: "one"\n  - event: session.created\n    actions:\n      - notify: "two"\n`],
        [projectPiPath, `hooks:\n  - event: tool.after.write\n    actions:\n      - notify: "three"\n`],
      ])

      const loaded = loadDiscoveredHooks({
        homeDir,
        projectDir,
        exists: (filePath) => existing.has(filePath),
        readFile: (filePath) => {
          const content = files.get(filePath)
          if (content === undefined) throw new Error(`missing fixture for ${filePath}`)
          return content
        },
      })

      const summary = formatHookLoadSummary(loaded)
      const expected = "[pi-hooks] Loaded 3 hooks (global: 2, project: 1)."
      return summary === expected
        ? { ok: true }
        : { ok: false, detail: `summary=${JSON.stringify(summary)}, sources=${JSON.stringify(loaded.sources)}` }
    }),
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
  /config-paths\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  const code = main()
  process.exit(code)
}

import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { getPiHooksLogger } from "./logger.js"

export interface HookConfigDiscoveryOptions {
  readonly projectDir?: string
  readonly platform?: string
  readonly homeDir?: string
  readonly appDataDir?: string
  readonly exists?: (filePath: string) => boolean
}

export interface HookConfigPaths {
  readonly global?: string
  readonly project?: string
}

export type HookConfigSourceScope = "global" | "project"

export interface DiscoveredHookConfigPath {
  readonly scope: HookConfigSourceScope
  readonly filePath: string
}

/**
 * Resolve the primary global and project config paths. Only PI-native
 * locations are considered:
 * - global: ~/.pi/agent/hook/hooks.yaml, then ~/.pi/agent/hooks.yaml
 * - project: <projectDir>/.pi/hook/hooks.yaml, then <projectDir>/.pi/hooks.yaml
 */
export function resolveHookConfigPaths(options: HookConfigDiscoveryOptions = {}): HookConfigPaths {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? resolveHomeDir()
  const appDataDir = options.appDataDir ?? process.env.APPDATA
  const projectDir = options.projectDir

  return {
    global: resolveGlobalConfigPath(exists, platform, homeDir, appDataDir),
    project: resolveProjectConfigPath(exists, projectDir),
  }
}

/**
 * Discover all existing PI-native config files in precedence order.
 *
 * Global comes before project so the project file can override the global one
 * (preserving original layering semantics).
 *
 * Project hook files are gated by an explicit trust list — a repo cannot drop
 * in `.pi/hook/hooks.yaml` or `.pi/hooks.yaml` and silently get arbitrary
 * `bash:` execution just
 * because someone `cd`'d into it. Trust is established by either:
 *   - Setting `PI_HOOKS_TRUST_PROJECT=1` for the process, or
 *   - Adding the absolute project directory to ~/.pi/agent/trusted-projects.json
 *     (a JSON array of absolute paths, e.g. ["/Users/me/code/myproj"]).
 * Untrusted project files are skipped with a one-time warning.
 */
export function discoverHookConfigEntries(options: HookConfigDiscoveryOptions = {}): DiscoveredHookConfigPath[] {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? resolveHomeDir()
  const appDataDir = options.appDataDir ?? process.env.APPDATA
  const projectDir = options.projectDir

  const entries: DiscoveredHookConfigPath[] = []
  const globalPath = pickFirstExisting(globalCandidatePaths(platform, homeDir, appDataDir), exists)
  if (globalPath) {
    entries.push({ scope: "global", filePath: globalPath })
  }

  if (projectDir) {
    const candidate = pickFirstExisting(projectCandidatePaths(projectDir), exists)
    if (candidate) {
      if (isProjectTrusted(projectDir, homeDir)) {
        entries.push({ scope: "project", filePath: candidate })
      } else {
        warnUntrustedProjectOnce(projectDir, candidate)
      }
    }
  }

  return entries
}

export function discoverHookConfigPaths(options: HookConfigDiscoveryOptions = {}): string[] {
  return discoverHookConfigEntries(options).map((entry) => entry.filePath)
}

const warnedUntrustedProjects = new Set<string>()

function warnUntrustedProjectOnce(projectDir: string, candidate: string): void {
  if (warnedUntrustedProjects.has(projectDir)) return
  warnedUntrustedProjects.add(projectDir)
  const message =
    `[pi-hooks] Skipping untrusted project hooks at ${candidate}.\n` +
    `         To trust this project, either:\n` +
    `           - set PI_HOOKS_TRUST_PROJECT=1 for this session, or\n` +
    `           - add ${JSON.stringify(projectDir)} to ~/.pi/agent/trusted-projects.json`
  // eslint-disable-next-line no-console
  console.warn(message)
  getPiHooksLogger().warn("project_untrusted", "Skipping untrusted project hooks.", {
    cwd: projectDir,
    details: { projectDir, candidate },
  })
}

function isProjectTrusted(projectDir: string, homeDir: string): boolean {
  if (process.env.PI_HOOKS_TRUST_PROJECT === "1") return true
  const trustFile = path.join(homeDir, ".pi", "agent", "trusted-projects.json")
  try {
    if (!existsSync(trustFile)) return false
    const raw = readFileSync(trustFile, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return false
    return parsed.some((entry) => typeof entry === "string" && path.resolve(entry) === path.resolve(projectDir))
  } catch {
    return false
  }
}

function resolveGlobalConfigPath(
  exists: (filePath: string) => boolean,
  platform: string,
  homeDir: string,
  appDataDir: string | undefined,
): string {
  const candidates = globalCandidatePaths(platform, homeDir, appDataDir)
  return pickFirstExisting(candidates, exists) ?? candidates[0]
}

function resolveProjectConfigPath(
  exists: (filePath: string) => boolean,
  projectDir: string | undefined,
): string | undefined {
  if (!projectDir) {
    return undefined
  }

  const candidates = projectCandidatePaths(projectDir)
  return pickFirstExisting(candidates, exists) ?? candidates[0]
}

function globalCandidatePaths(platform: string, homeDir: string, appDataDir: string | undefined): string[] {
  const candidates: string[] = [
    // PI-native preferred global config: ~/.pi/agent/hook/hooks.yaml
    path.join(homeDir, ".pi", "agent", "hook", "hooks.yaml"),
    // PI-native flat global config: ~/.pi/agent/hooks.yaml
    path.join(homeDir, ".pi", "agent", "hooks.yaml"),
  ]

  // PI-native on Windows: %APPDATA%/pi/agent/hook/hooks.yaml, then
  // %APPDATA%/pi/agent/hooks.yaml
  if (platform === "win32" && appDataDir) {
    candidates.push(path.join(appDataDir, "pi", "agent", "hook", "hooks.yaml"))
    candidates.push(path.join(appDataDir, "pi", "agent", "hooks.yaml"))
  }

  return candidates
}

function projectCandidatePaths(projectDir: string): string[] {
  return [
    // PI-native preferred project config: <projectDir>/.pi/hook/hooks.yaml
    path.join(projectDir, ".pi", "hook", "hooks.yaml"),
    // PI-native flat project config: <projectDir>/.pi/hooks.yaml
    path.join(projectDir, ".pi", "hooks.yaml"),
  ]
}

function pickFirstExisting(
  candidates: readonly string[],
  exists: (filePath: string) => boolean,
): string | undefined {
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate
    }
  }
  return undefined
}

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

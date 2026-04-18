import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

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

/**
 * Resolve the primary global and project config paths. PI-native locations
 * (`~/.pi/agent/hooks.yaml` globally, `<projectDir>/.pi/hooks.yaml` per-project)
 * win. If none of the PI-native paths exist, we fall back to the legacy
 * OpenCode locations so existing users keep working during the migration.
 */
export function resolveHookConfigPaths(options: HookConfigDiscoveryOptions = {}): HookConfigPaths {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const appDataDir = options.appDataDir ?? process.env.APPDATA
  const projectDir = options.projectDir

  return {
    global: resolveGlobalConfigPath(exists, platform, homeDir, appDataDir),
    project: resolveProjectConfigPath(exists, projectDir),
  }
}

/**
 * Discover all existing config files in precedence order: PI-native first,
 * OpenCode legacy second. Global comes before project so the project file can
 * override the global one (preserving original layering semantics).
 */
export function discoverHookConfigPaths(options: HookConfigDiscoveryOptions = {}): string[] {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const appDataDir = options.appDataDir ?? process.env.APPDATA
  const projectDir = options.projectDir

  const candidates: (string | undefined)[] = [
    // Global, PI-native then OpenCode fallback.
    pickFirstExisting(globalCandidatePaths(platform, homeDir, appDataDir), exists),
    // Project, PI-native then OpenCode fallback.
    projectDir ? pickFirstExisting(projectCandidatePaths(projectDir), exists) : undefined,
  ]

  return candidates.filter((filePath): filePath is string => Boolean(filePath))
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
    // PI-native: ~/.pi/agent/hooks.yaml
    path.join(homeDir, ".pi", "agent", "hooks.yaml"),
  ]

  // PI-native on Windows: %APPDATA%/pi/agent/hooks.yaml
  if (platform === "win32" && appDataDir) {
    candidates.push(path.join(appDataDir, "pi", "agent", "hooks.yaml"))
  }

  // Legacy OpenCode fallback: ~/.config/opencode/hook/hooks.yaml
  candidates.push(path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml"))

  // Legacy OpenCode fallback on Windows: %APPDATA%/opencode/hook/hooks.yaml
  if (platform === "win32" && appDataDir) {
    candidates.push(path.join(appDataDir, "opencode", "hook", "hooks.yaml"))
  }

  return candidates
}

function projectCandidatePaths(projectDir: string): string[] {
  return [
    // PI-native project config: <projectDir>/.pi/hooks.yaml
    path.join(projectDir, ".pi", "hooks.yaml"),
    // Legacy OpenCode project config fallback: <projectDir>/.opencode/hook/hooks.yaml
    path.join(projectDir, ".opencode", "hook", "hooks.yaml"),
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

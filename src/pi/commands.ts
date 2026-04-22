import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"

import { getPiHooksLogFilePath } from "../core/logger.js"
import {
  resolveHookConfigPaths,
} from "../core/config-paths.js"
import {
  formatHookLoadSummary,
  loadDiscoveredHooksSnapshot,
  loadHooksFile,
  summarizeHookSources,
} from "../core/load-hooks.js"

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("hooks-status", {
    description: "Show active hook files, trust state, and log path",
    handler: async (_args, ctx) => {
      const status = getHooksStatus(ctx)
      const lines = [
        `Hooks status for ${status.projectDir}`,
        `Active summary: ${formatHookLoadSummary({ sources: status.active.sources })}`,
        `Global config: ${formatStatusPath(status.paths.global)}`,
        `Project config: ${formatStatusPath(status.paths.project)}`,
        `Project trusted: ${status.projectTrusted ? "yes" : "no"}`,
        `Hook log: ${status.logFilePath}`,
      ]
      if (!status.projectTrusted && status.paths.project) {
        lines.push("Project hooks exist but are not active until the project is trusted.")
      }
      notifyCommand(ctx, lines.join("\n"), "info")
    },
  })

  pi.registerCommand("hooks-validate", {
    description: "Validate active and project hook files with actionable feedback",
    handler: async (_args, ctx) => {
      const validation = validateHooks(ctx)
      const lines = [`Hook validation for ${ctx.cwd}`]

      if (validation.active.errors.length === 0) {
        const summary = summarizeHookSources(validation.active.sources)
        lines.push(`Active hooks are valid: ${summary.total} loaded (${summary.global} global, ${summary.project} project).`)
      } else {
        lines.push("Active hook errors:")
        lines.push(...validation.active.errors.map(formatValidationError))
      }

      if (validation.project.exists && !validation.project.trusted) {
        if (validation.project.errors.length === 0) {
          lines.push(`Project hook file is valid but untrusted: ${validation.project.path}`)
          lines.push('Run /hooks-trust to activate it without editing trusted-projects.json by hand.')
        } else {
          lines.push(`Project hook file is untrusted and has validation errors: ${validation.project.path}`)
          lines.push(...validation.project.errors.map(formatValidationError))
        }
      }

      notifyCommand(
        ctx,
        lines.join("\n"),
        validation.active.errors.length > 0 || validation.project.errors.length > 0 ? "warning" : "info",
      )
    },
  })

  pi.registerCommand("hooks-trust", {
    description: "Trust the current project hook file",
    handler: async (_args, ctx) => {
      const projectDir = path.resolve(ctx.cwd)
      const trustFile = getTrustedProjectsFilePath()
      const current = readTrustedProjects(trustFile)
      if (!current.includes(projectDir)) {
        mkdirSync(path.dirname(trustFile), { recursive: true })
        writeFileSync(trustFile, JSON.stringify([...current, projectDir], null, 2) + "\n", "utf8")
      }

      notifyCommand(
        ctx,
        `Trusted project hooks for ${projectDir}. Run /hooks-validate or trigger another PI event to confirm the active hook set.`,
        "info",
      )
    },
  })

  pi.registerCommand("hooks-reload", {
    description: "Reload extensions and hook command surfaces",
    handler: async (_args, ctx) => {
      const message =
        "Reloading PI extensions. Edited hooks.yaml files also refresh automatically on the next relevant PI event even without this command."
      if (ctx.hasUI) {
        ctx.ui.notify(message, "info")
      } else {
        // eslint-disable-next-line no-console
        console.info(`[pi-hooks] ${message}`)
      }
      await ctx.reload()
    },
  })

  pi.registerCommand("hooks-tail-log", {
    description: "Show the hook log location and tail command",
    handler: async (_args, ctx) => {
      const logFilePath = getPiHooksLogFilePath()
      notifyCommand(
        ctx,
        `Hook log: ${logFilePath}\nTail it with: tail -F ${JSON.stringify(logFilePath)}`,
        "info",
      )
    },
  })
}

interface HooksStatus {
  readonly projectDir: string
  readonly projectTrusted: boolean
  readonly paths: ReturnType<typeof resolveHookConfigPaths>
  readonly active: ReturnType<typeof loadDiscoveredHooksSnapshot>
  readonly logFilePath: string
}

function getHooksStatus(ctx: ExtensionCommandContext): HooksStatus {
  const projectDir = path.resolve(ctx.cwd)
  const paths = resolveHookConfigPaths({ projectDir })
  const active = loadDiscoveredHooksSnapshot({ projectDir })
  const projectTrusted = active.sources.some((source) => source.scope === "project")

  return {
    projectDir,
    projectTrusted,
    paths,
    active,
    logFilePath: getPiHooksLogFilePath(),
  }
}

function validateHooks(ctx: ExtensionCommandContext): {
  readonly active: ReturnType<typeof loadDiscoveredHooksSnapshot>
  readonly project: {
    readonly exists: boolean
    readonly trusted: boolean
    readonly path?: string
    readonly errors: Array<{ filePath: string; path?: string; message: string }>
  }
} {
  const status = getHooksStatus(ctx)
  const activeProjectPaths = new Set(
    status.active.sources.filter((source) => source.scope === "project").map((source) => source.filePath),
  )
  const projectPath = status.paths.project
  const projectExists = Boolean(projectPath && existsSync(projectPath))
  const trusted = Boolean(projectPath && activeProjectPaths.has(projectPath))
  const projectErrors = projectExists && projectPath ? loadHooksFile(projectPath).errors : []

  return {
    active: status.active,
    project: {
      exists: projectExists,
      trusted,
      ...(projectPath ? { path: projectPath } : {}),
      errors: projectErrors,
    },
  }
}

function notifyCommand(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level)
  }
  // eslint-disable-next-line no-console
  console.info(`[pi-hooks] ${message}`)
}

function getTrustedProjectsFilePath(): string {
  return path.join(os.homedir(), ".pi", "agent", "trusted-projects.json")
}

function readTrustedProjects(filePath: string): string[] {
  try {
    if (!existsSync(filePath)) {
      return []
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

function formatValidationError(error: { filePath: string; path?: string; message: string }): string {
  return `- ${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`
}

function formatStatusPath(filePath: string | undefined): string {
  if (!filePath) {
    return "not applicable"
  }
  return existsSync(filePath) ? filePath : `${filePath} (missing)`
}

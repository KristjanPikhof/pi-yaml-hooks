import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent"

import { getPiHooksLogFilePath } from "../core/logger.js"
import {
  resolveProjectHookResolution,
  resolveHookConfigPaths,
} from "../core/config-paths.js"
import {
  formatHookLoadSummary,
  loadDiscoveredHooksSnapshot,
  loadHooksFile,
  summarizeHookSources,
} from "../core/load-hooks.js"
import { sendHookDiagnostics } from "./diagnostics.js"

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("hooks-status", {
    description: "Show active hook files, trust state, and log path",
    handler: async (_args, ctx) => {
      const status = getHooksStatus(ctx)
      const lines = [
        `Hooks status for ${status.projectDir}`,
        `Active summary: ${formatHookLoadSummary({ sources: status.active.sources })}`,
        `Global config: ${formatStatusPath(status.paths.global)}`,
        `Project config: ${formatStatusPath(status.projectStatusPath)}`,
        `Project trusted: ${status.projectTrusted ? "yes" : "no"}`,
        `Hook log: ${status.logFilePath}`,
      ]
      if (status.projectConfigExists && !status.projectTrusted) {
        lines.push("Project hooks exist but are not active until the project is trusted.")
      }
      sendHookDiagnostics(pi, {
        title: "Hook status",
        level: "info",
        content: lines.join("\n"),
        sections: [
          {
            label: "Loaded sources",
            lines: status.active.sources.map((source) => `${source.scope}: ${source.filePath} (${source.hookCount} hooks)`),
          },
        ],
      })
      notifyCommand(ctx, lines.join("\n"), "info", false)
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

      const level = validation.active.errors.length > 0 || validation.project.errors.length > 0 ? "warning" : "info"
      sendHookDiagnostics(pi, {
        title: "Hook validation",
        level,
        content: lines.join("\n"),
        sections: [
          {
            label: "Active validation errors",
            lines: validation.active.errors.length > 0 ? validation.active.errors.map(formatValidationError) : ["None"],
          },
          {
            label: "Project validation errors",
            lines: validation.project.errors.length > 0 ? validation.project.errors.map(formatValidationError) : ["None"],
          },
        ],
      })
      notifyCommand(ctx, lines.join("\n"), level, false)
    },
  })

  pi.registerCommand("hooks-trust", {
    description: "Trust the current project hook file",
    handler: async (_args, ctx) => {
      const projectDir = path.resolve(ctx.cwd)
      const project = resolveProjectHookResolution({ projectDir })
      if (!project?.projectConfigPath || !existsSync(project.projectConfigPath)) {
        notifyCommand(
          ctx,
          `No project hook file was found for ${projectDir}. Create ${project?.projectConfigPath ?? path.join(projectDir, ".pi", "hook", "hooks.yaml")} first, then run /hooks-trust again.`,
          "warning",
        )
        return
      }

      const trustFile = getTrustedProjectsFilePath()
      const current = readTrustedProjects(trustFile)
      if (!current.ok) {
        notifyCommand(
          ctx,
          `Cannot update ${trustFile} because it is not valid JSON. Fix or remove that file, then run /hooks-trust again.`,
          "error",
        )
        return
      }

      const trustAnchor = project.canonicalAnchorDir
      const normalizedCurrent = new Set(current.entries.map(canonicalizeForTrust))
      if (!normalizedCurrent.has(trustAnchor)) {
        mkdirSync(path.dirname(trustFile), { recursive: true })
        writeFileSync(trustFile, JSON.stringify([...current.entries, trustAnchor], null, 2) + "\n", "utf8")
      }

      notifyCommand(
        ctx,
        `Trusted project hooks for ${project.anchorDir}. Run /hooks-validate or trigger another PI event to confirm the active hook set.`,
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
  readonly projectConfigExists: boolean
  readonly projectStatusPath: string
  readonly paths: ReturnType<typeof resolveHookConfigPaths>
  readonly active: ReturnType<typeof loadDiscoveredHooksSnapshot>
  readonly logFilePath: string
}

function getHooksStatus(ctx: ExtensionCommandContext): HooksStatus {
  const projectDir = path.resolve(ctx.cwd)
  const paths = resolveHookConfigPaths({ projectDir })
  const active = loadDiscoveredHooksSnapshot({ projectDir })
  const project = resolveProjectHookResolution({ projectDir })
  const projectStatusPath =
    project?.projectConfigPath ??
    path.join(project?.discoveredProjectRoot ?? project?.worktreeRoot ?? projectDir, ".pi", "hook", "hooks.yaml")
  const projectConfigExists = existsSync(projectStatusPath)
  const projectTrusted = project?.trusted ?? false

  return {
    projectDir,
    projectTrusted,
    projectConfigExists,
    projectStatusPath,
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
  notifyUi = true,
): void {
  if (notifyUi && ctx.hasUI) {
    ctx.ui.notify(message, level)
  }
  // eslint-disable-next-line no-console
  console.info(`[pi-hooks] ${message}`)
}

function getTrustedProjectsFilePath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir()
  return path.join(homeDir, ".pi", "agent", "trusted-projects.json")
}

function readTrustedProjects(filePath: string):
  | { readonly ok: true; readonly entries: string[] }
  | { readonly ok: false } {
  try {
    if (!existsSync(filePath)) {
      return { ok: true, entries: [] }
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown
    if (!Array.isArray(parsed)) {
      return { ok: false }
    }
    return { ok: true, entries: parsed.filter((entry): entry is string => typeof entry === "string") }
  } catch {
    return { ok: false }
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

function canonicalizeForTrust(filePath: string): string {
  try {
    return path.resolve(realpathSync.native(filePath))
  } catch {
    return path.resolve(filePath)
  }
}

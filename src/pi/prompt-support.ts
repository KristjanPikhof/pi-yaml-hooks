import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"

import { resolveProjectHookResolution } from "../core/config-paths.js"
import { loadDiscoveredHooksSnapshot, summarizeHookSources } from "../core/load-hooks.js"

const PROMPT_AWARENESS_DISABLE_ENV = "PI_HOOKS_PROMPT_AWARENESS"

export function registerPromptSupport(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    const systemPrompt = buildHookAwarenessSystemPrompt(ctx)
    if (!systemPrompt) {
      return
    }

    return {
      systemPrompt: `${event.systemPrompt.trimEnd()}\n\n${systemPrompt}`,
    }
  })
}

function buildHookAwarenessSystemPrompt(ctx: ExtensionContext): string | undefined {
  if (process.env[PROMPT_AWARENESS_DISABLE_ENV] === "0") {
    return undefined
  }

  const loaded = loadDiscoveredHooksSnapshot({ projectDir: ctx.cwd })
  const summary = summarizeHookSources(loaded.sources)
  const project = resolveProjectHookResolution({ projectDir: ctx.cwd })
  const projectConfigExists = Boolean(project?.projectConfigPath)
  const trustLine = projectConfigExists
    ? project?.trusted
      ? "- project hooks are trusted and active when loaded"
      : "- project hooks exist but are currently untrusted"
    : "- no project hook file is present for this repo/worktree scope"

  const lines = ["Hook-awareness for this session:"]

  if (loaded.errors.length > 0) {
    lines.push(`- current hook files have ${loaded.errors.length} validation issue(s); the runtime may be using the valid subset or a last known good hook set`)
    lines.push("- use /hooks-validate for the exact validation errors and active trust state")
  } else {
    lines.push(`- pi-hooks loaded ${summary.total} hooks (${summary.global} global, ${summary.project} project)`)
    lines.push(trustLine)
  }

  lines.push("- command actions are unsupported on PI; prefer bash-backed hooks or user-invoked /hooks commands")
  lines.push("- cross-session targeting for non-bash actions is limited; tool prompts still target the current session")

  if (!ctx.hasUI) {
    lines.push("- UI is unavailable in this mode: notify/setStatus degrade and confirm denies by default")
  }

  return lines.join("\n")
}

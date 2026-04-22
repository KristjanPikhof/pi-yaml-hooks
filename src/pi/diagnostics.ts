import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Box, Text } from "@mariozechner/pi-tui"

export const PI_HOOKS_DIAGNOSTICS_MESSAGE_TYPE = "pi-hooks-diagnostics"

export interface HookDiagnosticsMessageDetails {
  readonly title: string
  readonly level: "info" | "warning" | "error"
  readonly sections?: Array<{
    readonly label: string
    readonly lines: string[]
  }>
}

export function registerHookDiagnostics(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<HookDiagnosticsMessageDetails>(
    PI_HOOKS_DIAGNOSTICS_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details
      const level = details?.level ?? "info"
      const title = details?.title ?? "pi-hooks diagnostics"
      const badgeColor = level === "error" ? "error" : level === "warning" ? "warning" : "success"
      const lines = [`${theme.fg(badgeColor, `[${level.toUpperCase()}]`)} ${title}`, String(message.content)]

      if (expanded && details?.sections) {
        for (const section of details.sections) {
          lines.push("")
          lines.push(theme.fg("dim", section.label))
          lines.push(...section.lines)
        }
      }

      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text))
      box.addChild(new Text(lines.join("\n"), 0, 0))
      return box
    },
  )
}

export function sendHookDiagnostics(
  pi: ExtensionAPI,
  message: {
    readonly content: string
    readonly title: string
    readonly level: "info" | "warning" | "error"
    readonly sections?: HookDiagnosticsMessageDetails["sections"]
  },
): void {
  pi.sendMessage<HookDiagnosticsMessageDetails>({
    customType: PI_HOOKS_DIAGNOSTICS_MESSAGE_TYPE,
    content: message.content,
    display: true,
    details: {
      title: message.title,
      level: message.level,
      ...(message.sections ? { sections: message.sections } : {}),
    },
  })
}

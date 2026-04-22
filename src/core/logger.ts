import { appendFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type PiHooksLogLevel = "error" | "warn" | "info" | "debug"

export interface PiHooksLogEntry {
  readonly ts?: string
  readonly level?: PiHooksLogLevel
  readonly kind: string
  readonly message?: string
  readonly event?: string
  readonly sessionId?: string
  readonly cwd?: string
  readonly hookId?: string
  readonly hookSource?: string
  readonly action?: string
  readonly toolName?: string
  readonly details?: Record<string, unknown>
}

interface PiHooksLogger {
  readonly enabled: boolean
  readonly filePath?: string
  readonly level?: PiHooksLogLevel
  log(entry: PiHooksLogEntry): void
  error(kind: string, message: string, fields?: Omit<PiHooksLogEntry, "kind" | "message" | "level">): void
  warn(kind: string, message: string, fields?: Omit<PiHooksLogEntry, "kind" | "message" | "level">): void
  info(kind: string, message: string, fields?: Omit<PiHooksLogEntry, "kind" | "message" | "level">): void
  debug(kind: string, message: string, fields?: Omit<PiHooksLogEntry, "kind" | "message" | "level">): void
}

const LEVEL_PRIORITIES: Record<PiHooksLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

const MAX_STRING_LENGTH = 2_048
const MAX_ARRAY_LENGTH = 50
const MAX_OBJECT_KEYS = 50
const MAX_DEPTH = 5
const REDACTED = "[REDACTED]"

let cachedLogger: PiHooksLogger | undefined
let warnedAboutLoggerFailure = false

export function getPiHooksLogger(): PiHooksLogger {
  cachedLogger ??= createPiHooksLogger()
  return cachedLogger
}

export function getPiHooksLogFilePath(): string {
  return resolveLogFilePath()
}

export function resetPiHooksLoggerForTests(): void {
  cachedLogger = undefined
  warnedAboutLoggerFailure = false
}

function createPiHooksLogger(): PiHooksLogger {
  const enabled = shouldEnableLogging()
  const level = resolveLogLevel(enabled)
  const filePath = enabled ? resolveLogFilePath() : undefined
  const mirrorToStderr = process.env.PI_HOOKS_LOG_STDERR === "1"

  return {
    enabled,
    ...(filePath ? { filePath } : {}),
    ...(level ? { level } : {}),
    log(entry: PiHooksLogEntry): void {
      if (!enabled || !level || !filePath) {
        return
      }

      const entryLevel = entry.level ?? "info"
      if (LEVEL_PRIORITIES[entryLevel] > LEVEL_PRIORITIES[level]) {
        return
      }

      const line = serializeLogEntry({
        ...entry,
        level: entryLevel,
        ts: entry.ts ?? new Date().toISOString(),
      })

      try {
        mkdirSync(path.dirname(filePath), { recursive: true })
        appendFileSync(filePath, `${line}\n`, "utf8")
      } catch (error) {
        if (!warnedAboutLoggerFailure) {
          warnedAboutLoggerFailure = true
          const message = error instanceof Error ? error.message : String(error)
          // eslint-disable-next-line no-console
          console.warn(`[pi-hooks] Failed to write debug log ${filePath}: ${message}`)
        }
      }

      if (mirrorToStderr) {
        const message = `[pi-hooks:${entryLevel}] ${entry.kind}${entry.message ? ` ${entry.message}` : ""}`
        // eslint-disable-next-line no-console
        console.warn(message)
      }
    },
    error(kind: string, message: string, fields = {}): void {
      this.log({ level: "error", kind, message, ...fields })
    },
    warn(kind: string, message: string, fields = {}): void {
      this.log({ level: "warn", kind, message, ...fields })
    },
    info(kind: string, message: string, fields = {}): void {
      this.log({ level: "info", kind, message, ...fields })
    },
    debug(kind: string, message: string, fields = {}): void {
      this.log({ level: "debug", kind, message, ...fields })
    },
  }
}

function shouldEnableLogging(): boolean {
  return (
    process.env.PI_HOOKS_DEBUG === "1" ||
    process.env.PI_HOOKS_LOG_LEVEL !== undefined ||
    process.env.PI_HOOKS_LOG_FILE !== undefined
  )
}

function resolveLogLevel(enabled: boolean): PiHooksLogLevel | undefined {
  if (!enabled) {
    return undefined
  }

  const envLevel = process.env.PI_HOOKS_LOG_LEVEL
  if (envLevel === "error" || envLevel === "warn" || envLevel === "info" || envLevel === "debug") {
    return envLevel
  }

  if (process.env.PI_HOOKS_DEBUG === "1") {
    return "debug"
  }

  return "info"
}

function resolveLogFilePath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir()
  return process.env.PI_HOOKS_LOG_FILE || path.join(homeDir, ".pi", "agent", "logs", "pi-hooks.ndjson")
}

function serializeLogEntry(entry: PiHooksLogEntry): string {
  return JSON.stringify(sanitizeValue(entry, 0))
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value == null) {
    return value
  }

  if (typeof value === "string") {
    return truncateString(redactSensitiveContent(value))
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (depth >= MAX_DEPTH) {
    return "[Truncated depth]"
  }

  if (Array.isArray(value)) {
    const entries = value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeValue(entry, depth + 1))
    if (value.length > MAX_ARRAY_LENGTH) {
      entries.push(`[Truncated ${value.length - MAX_ARRAY_LENGTH} more items]`)
    }
    return entries
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    const sanitized: Record<string, unknown> = {}
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      sanitized[key] = sanitizeValue(record[key], depth + 1)
    }
    if (keys.length > MAX_OBJECT_KEYS) {
      sanitized.__truncatedKeys = keys.length - MAX_OBJECT_KEYS
    }
    return sanitized
  }

  return String(value)
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}… [truncated ${value.length - MAX_STRING_LENGTH} chars]`
}

function redactSensitiveContent(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*bearer\s+)([^\s]+)/gi, `$1${REDACTED}`)
    .replace(
      /((?:\\?["'])?(?:api[-_ ]?key|token|secret|password|passwd|pwd)(?:\\?["'])?[^\S\r\n]*[:=][^\S\r\n]*)(\\?["'])(.*?)(\2)/gi,
      (_match, prefix: string, openingQuote: string, _secretValue: string, closingQuote: string) =>
        `${prefix}${openingQuote}${REDACTED}${closingQuote}`,
    )
    .replace(
      /(["']?(?:api[-_ ]?key|token|secret|password|passwd|pwd)["']?[^\S\r\n]*[:=][^\S\r\n]*)([^\s,"'}\]`]+)/gi,
      `$1${REDACTED}`,
    )
}

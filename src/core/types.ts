export const SESSION_HOOK_EVENTS = ["session.idle", "session.created", "session.deleted", "file.changed"] as const
export const LEGACY_HOOK_CONDITIONS = ["matchesCodeFiles"] as const
export const PATH_HOOK_CONDITION_KEYS = ["matchesAnyPath", "matchesAllPaths"] as const
export const HOOK_SCOPES = ["all", "main", "child"] as const
export const HOOK_RUN_IN = ["current", "main"] as const
export const HOOK_BEHAVIORS = ["stop"] as const

export type SessionHookEvent = (typeof SESSION_HOOK_EVENTS)[number]
export type ToolHookPhase = "before" | "after"
export type ToolHookEvent = `tool.${ToolHookPhase}.*` | `tool.${ToolHookPhase}.${string}`
export type HookEvent = SessionHookEvent | ToolHookEvent
export type HookLegacyCondition = (typeof LEGACY_HOOK_CONDITIONS)[number]
export type HookPathConditionKey = (typeof PATH_HOOK_CONDITION_KEYS)[number]
export type HookPathCondition =
  | { readonly matchesAnyPath: readonly string[] }
  | { readonly matchesAllPaths: readonly string[] }
export type HookCondition = HookLegacyCondition | HookPathCondition
export type HookScope = (typeof HOOK_SCOPES)[number]
export type HookRunIn = (typeof HOOK_RUN_IN)[number]
export type HookBehavior = (typeof HOOK_BEHAVIORS)[number]

export interface CreateFileChange {
  readonly operation: "create"
  readonly path: string
}

export interface ModifyFileChange {
  readonly operation: "modify"
  readonly path: string
}

export interface DeleteFileChange {
  readonly operation: "delete"
  readonly path: string
}

export interface RenameFileChange {
  readonly operation: "rename"
  readonly fromPath: string
  readonly toPath: string
}

export type FileChange = CreateFileChange | ModifyFileChange | DeleteFileChange | RenameFileChange

export interface HookCommandActionConfig {
  readonly name: string
  readonly args?: string
}

export interface HookToolActionConfig {
  readonly name: string
  readonly args?: Record<string, unknown>
}

export interface HookBashActionConfig {
  readonly command: string
  readonly timeout?: number
}

export interface HookCommandAction {
  readonly command: string | HookCommandActionConfig
}

export interface HookToolAction {
  readonly tool: HookToolActionConfig
}

export interface HookBashAction {
  readonly bash: string | HookBashActionConfig
}

export type HookNotifyLevel = "info" | "success" | "warning" | "error"

export interface HookNotifyActionConfig {
  readonly text: string
  readonly level?: HookNotifyLevel
}

export interface HookNotifyAction {
  readonly notify: string | HookNotifyActionConfig
}

export interface HookConfirmActionConfig {
  readonly title?: string
  readonly message: string
}

export interface HookConfirmAction {
  readonly confirm: HookConfirmActionConfig
}

export interface HookSetStatusActionConfig {
  readonly text: string
}

export interface HookSetStatusAction {
  readonly setStatus: string | HookSetStatusActionConfig
}

export type HookAction =
  | HookCommandAction
  | HookToolAction
  | HookBashAction
  | HookNotifyAction
  | HookConfirmAction
  | HookSetStatusAction

export interface HookConfigSource {
  readonly filePath: string
  readonly index: number
}

export interface HookConfig {
  readonly id?: string
  readonly event: HookEvent
  readonly action?: HookBehavior
  readonly actions: HookAction[]
  readonly scope: HookScope
  readonly runIn: HookRunIn
  readonly async?: boolean
  readonly conditions?: HookCondition[]
  readonly source: HookConfigSource
}

export interface HookOverrideEntry {
  readonly targetId: string
  readonly disable: boolean
  readonly replacement?: HookConfig
  readonly source: HookConfigSource
}

export type HookMap = Map<HookEvent, HookConfig[]>

export type HookValidationErrorCode =
  | "invalid_frontmatter"
  | "missing_hooks"
  | "invalid_hooks"
  | "invalid_hook"
  | "invalid_event"
  | "invalid_scope"
  | "invalid_run_in"
  | "invalid_hook_action"
  | "invalid_conditions"
  | "invalid_actions"
  | "invalid_action"
  | "duplicate_hook_id"
  | "override_target_not_found"
  | "invalid_override"
  | "invalid_async"
  | "unsupported_on_pi"

export interface HookValidationError {
  readonly code: HookValidationErrorCode
  readonly filePath: string
  readonly message: string
  readonly path?: string
}

export interface ParsedHooksFile {
  readonly hooks: HookMap
  readonly overrides: HookOverrideEntry[]
  readonly errors: HookValidationError[]
  readonly advisories?: string[]
}

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string" && (SESSION_HOOK_EVENTS.includes(value as SessionHookEvent) || /^tool\.(before|after)\.(\*|.+)$/.test(value))
}

export function isHookLegacyCondition(value: unknown): value is HookLegacyCondition {
  return typeof value === "string" && LEGACY_HOOK_CONDITIONS.includes(value as HookLegacyCondition)
}

export function isHookPathConditionKey(value: unknown): value is HookPathConditionKey {
  return typeof value === "string" && PATH_HOOK_CONDITION_KEYS.includes(value as HookPathConditionKey)
}

export function isHookScope(value: unknown): value is HookScope {
  return typeof value === "string" && HOOK_SCOPES.includes(value as HookScope)
}

export function isHookRunIn(value: unknown): value is HookRunIn {
  return typeof value === "string" && HOOK_RUN_IN.includes(value as HookRunIn)
}

export function isHookBehavior(value: unknown): value is HookBehavior {
  return typeof value === "string" && HOOK_BEHAVIORS.includes(value as HookBehavior)
}

// Host adapter is imported from the runtime embedder (for example the PI
// adapter in src/pi). Runtime code calls into the host exclusively through
// this surface so the core stays host-agnostic.
import type { BashExecutionRequest, BashHookResult } from "./bash-types.js"

export interface HostDeliveryResult {
  /**
   * `accepted` means the host API accepted the request without throwing.
   * `degraded` means the action was intentionally skipped or downgraded.
   */
  readonly status: "accepted" | "degraded"
  readonly reason?: string
  readonly details?: Record<string, unknown>
}

export interface HostAdapter {
  /** Abort the given session (best-effort). Errors must be handled by the adapter. */
  abort(sessionId: string): void | Promise<void>
  /** Return the root/parent-less session id reachable from `sessionId`. */
  getRootSessionId(sessionId: string): string | Promise<string>
  /** Execute a bash hook request; same contract as the node bash-executor. */
  runBash(request: BashExecutionRequest): Promise<BashHookResult>
  /** Queue a prompt in the current session; used as the fallback for `tool:` actions. */
  sendPrompt(sessionId: string, text: string): void | HostDeliveryResult | Promise<void | HostDeliveryResult>
  /**
   * Show a user-visible notification. Optional: hosts that do not implement
   * a UI surface (e.g. headless tests, non-PI embedders) may omit this; the
   * runtime degrades to a log + skip in that case.
   */
  notify?(text: string, level?: HookNotifyLevel): void | HostDeliveryResult | Promise<void | HostDeliveryResult>
  /**
   * Prompt the user for confirmation. Must resolve to a boolean: `true` =
   * user approved, `false` = user rejected (treated as a blocking result
   * for pre-tool hooks, same as exit-code-2 from a bash action).
   */
  confirm?(options: { title?: string; message: string }): boolean | Promise<boolean>
  /**
   * Set a status-bar entry for the given hookId. Pass an empty string to
   * clear; hosts without a status surface may omit this.
   */
  setStatus?(hookId: string, text: string): void | HostDeliveryResult | Promise<void | HostDeliveryResult>
}

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

export type HookAction = HookCommandAction | HookToolAction | HookBashAction

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

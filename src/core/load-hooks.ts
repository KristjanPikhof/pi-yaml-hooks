import { readFileSync } from "node:fs"

import YAML from "yaml"

import {
  type HookAction,
  type HookBashActionConfig,
  type HookBehavior,
  type HookCommandActionConfig,
  type HookCondition,
  type HookConfig,
  type HookOverrideEntry,
  type HookRunIn,
  type HookScope,
  type HookMap,
  type HookPathConditionKey,
  type HookToolActionConfig,
  type HookValidationError,
  type ParsedHooksFile,
  isHookBehavior,
  isHookEvent,
  isHookLegacyCondition,
  isHookPathConditionKey,
  isHookRunIn,
  isHookScope,
} from "./types.js"
import { discoverHookConfigPaths, type HookConfigDiscoveryOptions } from "./config-paths.js"

export interface HookDiscoveryResult {
  readonly hooks: HookMap
  readonly errors: HookValidationError[]
  readonly files: string[]
}

export interface HookLoadOptions extends HookConfigDiscoveryOptions {
  readonly readFile?: (filePath: string) => string
}

export interface HookLoadSnapshot extends HookDiscoveryResult {
  readonly signature: string
}

type ParsedHooksFileResult = ParsedHooksFile & { readonly files: string[] }
type DiscoveredHooksFileSnapshot =
  | { readonly filePath: string; readonly content: string }
  | { readonly filePath: string; readonly readError: string }

export function parseHooksFile(filePath: string, content: string): ParsedHooksFileResult {
  const document = YAML.parseDocument(content)
  if (document.errors.length > 0) {
    return {
      hooks: new Map(),
      overrides: [],
      errors: [{ code: "invalid_frontmatter", filePath, message: document.errors[0]?.message ?? "Failed to parse hooks.yaml." }],
      files: [filePath],
    }
  }

  const parsed = document.toJS()

  if (!isRecord(parsed)) {
    return {
      hooks: new Map(),
      overrides: [],
      errors: [{ code: "invalid_frontmatter", filePath, message: "hooks.yaml must parse to an object." }],
      files: [filePath],
    }
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, "hooks")) {
    return {
      hooks: new Map(),
      overrides: [],
      errors: [{ code: "missing_hooks", filePath, message: "hooks.yaml must define a hooks list.", path: "hooks" }],
      files: [filePath],
    }
  }

  if (!Array.isArray(parsed.hooks)) {
    return {
      hooks: new Map(),
      overrides: [],
      errors: [{ code: "invalid_hooks", filePath, message: "hooks must be an array.", path: "hooks" }],
      files: [filePath],
    }
  }

  const hooks = new Map<HookConfig["event"], HookConfig[]>()
  const overrides: HookOverrideEntry[] = []
  const errors: HookValidationError[] = []
  const seenIds = new Set<string>()

  parsed.hooks.forEach((hookDefinition, index) => {
    const parsedHook = parseHookDefinition(filePath, hookDefinition, index, seenIds)
    errors.push(...parsedHook.errors)
    if (!parsedHook.hook) {
      if (parsedHook.override) {
        overrides.push(parsedHook.override)
      }
      return
    }

    if (parsedHook.override) {
      overrides.push(parsedHook.override)
      return
    }

    const existing = hooks.get(parsedHook.hook.event) ?? []
    hooks.set(parsedHook.hook.event, [...existing, parsedHook.hook])
  })

  return { hooks, overrides, errors, files: [filePath] }
}

export function loadHooksFile(filePath: string, readFile: (filePath: string) => string = defaultReadFile): ParsedHooksFileResult {
  try {
    return parseHooksFile(filePath, readFile(filePath))
  } catch (error) {
    return {
      hooks: new Map(),
      overrides: [],
      errors: [{ code: "invalid_frontmatter", filePath, message: formatHookReadError(error) }],
      files: [filePath],
    }
  }
}

export function loadDiscoveredHooks(options: HookLoadOptions = {}): HookDiscoveryResult {
  const files = discoverHookConfigPaths(options)
  return loadDiscoveredHooksFromFiles(files, options)
}

export function loadDiscoveredHooksSnapshot(options: HookLoadOptions = {}): HookLoadSnapshot {
  const files = discoverHookConfigPaths(options)
  const snapshots = snapshotDiscoveredHookFiles(files, options.readFile ?? defaultReadFile)

  return {
    ...loadDiscoveredHooksFromSnapshots(snapshots),
    signature: JSON.stringify(
      snapshots.map((snapshot) =>
        "content" in snapshot ? [snapshot.filePath, snapshot.content] : [snapshot.filePath, `__read_error__:${snapshot.readError}`],
      ),
    ),
  }
}

function loadDiscoveredHooksFromFiles(files: string[], options: HookLoadOptions): HookDiscoveryResult {
  const readFile = options.readFile ?? defaultReadFile
  const snapshots = snapshotDiscoveredHookFiles(files, readFile)

  return loadDiscoveredHooksFromSnapshots(snapshots)
}

function loadDiscoveredHooksFromSnapshots(snapshots: readonly DiscoveredHooksFileSnapshot[]): HookDiscoveryResult {
  const hooks = new Map<HookConfig["event"], HookConfig[]>()
  const errors: HookValidationError[] = []

  for (const snapshot of snapshots) {
    const result = loadSnapshotHooksFile(snapshot)
    const resolved = resolveOverrides(hooks, result.overrides)
    hooks.clear()
    mergeHookMapsInto(hooks, resolved.hooks)
    mergeHookMapsInto(hooks, result.hooks)
    errors.push(...resolved.errors)
    errors.push(...result.errors)
  }

  return { hooks, errors, files: snapshots.map((snapshot) => snapshot.filePath) }
}

function snapshotDiscoveredHookFiles(files: readonly string[], readFile: (filePath: string) => string): DiscoveredHooksFileSnapshot[] {
  return files.map((filePath) => {
    try {
      return { filePath, content: readFile(filePath) }
    } catch (error) {
      return { filePath, readError: formatHookReadError(error) }
    }
  })
}

function loadSnapshotHooksFile(snapshot: DiscoveredHooksFileSnapshot): ParsedHooksFileResult {
  if ("content" in snapshot) {
    return parseHooksFile(snapshot.filePath, snapshot.content)
  }

  return {
    hooks: new Map(),
    overrides: [],
    errors: [{ code: "invalid_frontmatter", filePath: snapshot.filePath, message: snapshot.readError }],
    files: [snapshot.filePath],
  }
}

export function mergeHookMaps(...hookMaps: HookMap[]): HookMap {
  const merged = new Map<HookConfig["event"], HookConfig[]>()
  for (const hookMap of hookMaps) {
    mergeHookMapsInto(merged, hookMap)
  }
  return merged
}

function mergeHookMapsInto(target: HookMap, source: HookMap): void {
  for (const [event, configs] of source) {
    target.set(event, [...(target.get(event) ?? []), ...configs])
  }
}

function parseHookDefinition(
  filePath: string,
  hookDefinition: unknown,
  index: number,
  seenIds: Set<string>,
): { hook?: HookConfig; override?: HookOverrideEntry; errors: HookValidationError[] } {
  if (!isRecord(hookDefinition)) {
    return { errors: [createError(filePath, "invalid_hook", `hooks[${index}] must be an object.`, `hooks[${index}]`)] }
  }

  const idResult = parseHookId(filePath, hookDefinition.id, index, seenIds)
  const overrideResult = parseOverrideTarget(filePath, hookDefinition.override, hookDefinition.disable, index)

  if (overrideResult.isDisableOverride) {
    return {
      override: {
        targetId: overrideResult.targetId!,
        disable: true,
        source: { filePath, index },
      },
      errors: [...idResult.errors, ...overrideResult.errors],
    }
  }

  const event = hookDefinition.event
  if (!isHookEvent(event)) {
    return { errors: [...idResult.errors, ...overrideResult.errors, createError(filePath, "invalid_event", `hooks[${index}].event is not a supported hook event.`, `hooks[${index}].event`)] }
  }

  const scopeResult = parseScope(filePath, hookDefinition.scope, index)
  const runInResult = parseRunIn(filePath, hookDefinition.runIn, index)
  const actionResult = parseHookAction(filePath, hookDefinition.action, event, index)
  const asyncResult = parseAsync(filePath, hookDefinition.async, event, hookDefinition.actions, index)

  const conditionsResult = parseConditions(filePath, hookDefinition.conditions, event, index)
  const actionsResult = parseActions(filePath, hookDefinition.actions, index)
  const errors = [...idResult.errors, ...overrideResult.errors, ...scopeResult.errors, ...runInResult.errors, ...actionResult.errors, ...asyncResult.errors, ...conditionsResult.errors, ...actionsResult.errors]

  if (errors.length > 0 || actionsResult.actions.length === 0) {
    return { errors }
  }

  const hook: HookConfig = {
    ...(idResult.id ? { id: idResult.id } : {}),
    event,
    ...(actionResult.action ? { action: actionResult.action } : {}),
    actions: actionsResult.actions,
    scope: scopeResult.scope,
    runIn: runInResult.runIn,
    ...(asyncResult.async ? { async: true } : {}),
    ...(conditionsResult.conditions ? { conditions: conditionsResult.conditions } : {}),
    source: { filePath, index },
  }

  if (overrideResult.targetId) {
    return {
      override: {
        targetId: overrideResult.targetId,
        disable: false,
        replacement: hook,
        source: { filePath, index },
      },
      errors,
    }
  }

  return {
    hook,
    errors,
  }
}

export function resolveOverrides(hooks: HookMap, overrides: HookOverrideEntry[]): { hooks: HookMap; errors: HookValidationError[] } {
  const orderedHooks = flattenHookMap(hooks)
  const errors: HookValidationError[] = []

  for (const override of overrides) {
    const hookIndexById = new Map<string, number>()
    orderedHooks.forEach((hook, index) => {
      if (hook.id) {
        hookIndexById.set(hook.id, index)
      }
    })

    const targetIndex = hookIndexById.get(override.targetId)
    if (targetIndex === undefined) {
      errors.push(
        createError(
          override.source.filePath,
          "override_target_not_found",
          `hooks[${override.source.index}].override targets unknown hook id \"${override.targetId}\".`,
          `hooks[${override.source.index}].override`,
        ),
      )
      continue
    }

    if (override.disable) {
      orderedHooks.splice(targetIndex, 1)
      continue
    }

    if (override.replacement) {
      orderedHooks.splice(targetIndex, 1, override.replacement)
    }
  }

  return { hooks: toHookMap(orderedHooks), errors }
}

function parseScope(filePath: string, scope: unknown, index: number): { scope: HookScope; errors: HookValidationError[] } {
  if (scope === undefined) {
    return { scope: "all", errors: [] }
  }

  if (!isHookScope(scope)) {
    return {
      scope: "all",
      errors: [createError(filePath, "invalid_scope", `hooks[${index}].scope must be one of: all, main, child.`, `hooks[${index}].scope`)],
    }
  }

  return { scope, errors: [] }
}

function parseRunIn(filePath: string, runIn: unknown, index: number): { runIn: HookRunIn; errors: HookValidationError[] } {
  if (runIn === undefined) {
    return { runIn: "current", errors: [] }
  }

  if (!isHookRunIn(runIn)) {
    return {
      runIn: "current",
      errors: [createError(filePath, "invalid_run_in", `hooks[${index}].runIn must be one of: current, main.`, `hooks[${index}].runIn`)],
    }
  }

  return { runIn, errors: [] }
}

function parseAsync(filePath: string, async_: unknown, event: unknown, actions: unknown, index: number): { async?: boolean; errors: HookValidationError[] } {
  if (async_ === undefined) {
    return { errors: [] }
  }

  if (typeof async_ !== "boolean") {
    return {
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async must be a boolean.`, `hooks[${index}].async`)],
    }
  }

  if (async_ && typeof event === "string" && event.startsWith("tool.before")) {
    return {
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async cannot be true for tool.before events because blocking requires synchronous execution.`, `hooks[${index}].async`)],
    }
  }

  if (async_ && typeof event === "string" && event === "session.idle") {
    return {
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async cannot be true for session.idle events because idle dispatch must complete before tracked changes are consumed.`, `hooks[${index}].async`)],
    }
  }

  if (async_ && Array.isArray(actions) && actions.some((a) => typeof a === "object" && a !== null && ("command" in a || "tool" in a))) {
    return {
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async hooks must use only bash actions. command and tool actions have no timeout and can stall the async queue.`, `hooks[${index}].async`)],
    }
  }

  return { async: async_ === true ? true : undefined, errors: [] }
}

function parseHookAction(
  filePath: string,
  action: unknown,
  event: HookConfig["event"],
  index: number,
): { action?: HookBehavior; errors: HookValidationError[] } {
  if (action === undefined) {
    return { errors: [] }
  }

  if (!isHookBehavior(action)) {
    return {
      errors: [createError(filePath, "invalid_hook_action", `hooks[${index}].action must be: stop.`, `hooks[${index}].action`)],
    }
  }

  if (!event.startsWith("tool.before.")) {
    return {
      errors: [createError(filePath, "invalid_hook_action", `hooks[${index}].action is only supported on tool.before.* events.`, `hooks[${index}].action`)],
    }
  }

  return { action, errors: [] }
}

function parseConditions(
  filePath: string,
  conditions: unknown,
  event: HookConfig["event"],
  index: number,
): { conditions?: HookCondition[]; errors: HookValidationError[] } {
  if (conditions === undefined) {
    return { errors: [] }
  }

  if (!Array.isArray(conditions)) {
    return {
      errors: [createError(filePath, "invalid_conditions", `hooks[${index}].conditions must be an array.`, `hooks[${index}].conditions`)],
    }
  }

  const parsedConditions: HookCondition[] = []

  for (const [conditionIndex, condition] of conditions.entries()) {
    if (isHookLegacyCondition(condition)) {
      parsedConditions.push(condition)
      continue
    }

    const parsedCondition = parseStructuredCondition(filePath, condition, event, index, conditionIndex)
    if (parsedCondition.error) {
      return { errors: [parsedCondition.error] }
    }

    parsedConditions.push(parsedCondition.condition)
  }

  return { conditions: parsedConditions, errors: [] }
}

function parseStructuredCondition(
  filePath: string,
  condition: unknown,
  event: HookConfig["event"],
  hookIndex: number,
  conditionIndex: number,
): { condition: HookCondition; error?: undefined } | { condition?: undefined; error: HookValidationError } {
  const conditionPath = `hooks[${hookIndex}].conditions[${conditionIndex}]`

  if (!isRecord(condition)) {
    return {
      error: createError(filePath, "invalid_conditions", `${conditionPath} is not a supported condition.`, conditionPath),
    }
  }

  const keys = Object.keys(condition)
  if (keys.length !== 1) {
    return {
      error: createError(
        filePath,
        "invalid_conditions",
        `${conditionPath} must define exactly one supported condition key.`,
        conditionPath,
      ),
    }
  }

  const [key] = keys
  if (!isHookPathConditionKey(key)) {
    return {
      error: createError(filePath, "invalid_conditions", `${conditionPath}.${key} is not a supported condition key.`, `${conditionPath}.${key}`),
    }
  }

  if (!supportsPathConditions(event)) {
    return {
      error: createError(
        filePath,
        "invalid_conditions",
        `${conditionPath}.${key} is only supported on file.changed and session.idle hooks.`,
        `${conditionPath}.${key}`,
      ),
    }
  }

  const values = normalizePathConditionValues(condition[key], `${conditionPath}.${key}`)
  if (values.error) {
    return { error: createError(filePath, "invalid_conditions", values.error.message, values.error.path) }
  }

  return { condition: { [key]: values.values } as Record<HookPathConditionKey, readonly string[]> as HookCondition }
}

function normalizePathConditionValues(
  value: unknown,
  path: string,
): { values: readonly string[]; error?: undefined } | { values?: undefined; error: { message: string; path: string } } {
  if (isNonEmptyString(value)) {
    return { values: [value] }
  }

  if (!Array.isArray(value)) {
    return {
      error: {
        message: `${path} must be a non-empty string or non-empty string array.`,
        path,
      },
    }
  }

  if (value.length === 0) {
    return {
      error: {
        message: `${path} must not be an empty array.`,
        path,
      },
    }
  }

  const invalidIndex = value.findIndex((entry) => !isNonEmptyString(entry))
  if (invalidIndex >= 0) {
    return {
      error: {
        message: `${path}[${invalidIndex}] must be a non-empty string.`,
        path: `${path}[${invalidIndex}]`,
      },
    }
  }

  return { values: [...value] }
}

function supportsPathConditions(event: HookConfig["event"]): event is "file.changed" | "session.idle" {
  return event === "file.changed" || event === "session.idle"
}

function parseActions(
  filePath: string,
  actions: unknown,
  index: number,
): { actions: HookAction[]; errors: HookValidationError[] } {
  if (!Array.isArray(actions)) {
    return {
      actions: [],
      errors: [createError(filePath, "invalid_actions", `hooks[${index}].actions must be a non-empty array.`, `hooks[${index}].actions`)],
    }
  }

  if (actions.length === 0) {
    return {
      actions: [],
      errors: [createError(filePath, "invalid_actions", `hooks[${index}].actions must be a non-empty array.`, `hooks[${index}].actions`)],
    }
  }

  const parsedActions: HookAction[] = []
  const errors: HookValidationError[] = []

  actions.forEach((action, actionIndex) => {
    const parsedAction = parseAction(filePath, action, index, actionIndex)
    if (parsedAction.action) {
      parsedActions.push(parsedAction.action)
    }
    errors.push(...parsedAction.errors)
  })

  return { actions: parsedActions, errors }
}

function parseAction(
  filePath: string,
  action: unknown,
  hookIndex: number,
  actionIndex: number,
): { action?: HookAction; errors: HookValidationError[] } {
  const path = `hooks[${hookIndex}].actions[${actionIndex}]`
  if (!isRecord(action)) {
    return { errors: [createError(filePath, "invalid_action", `${path} must be an object.`, path)] }
  }

  const keys = ["command", "tool", "bash"].filter((key) => key in action)
  if (keys.length !== 1) {
    return { errors: [createError(filePath, "invalid_action", `${path} must define exactly one of command, tool, or bash.`, path)] }
  }

  if ("command" in action) {
    const command = parseCommandAction(action.command)
    return command
      ? { action: { command }, errors: [] }
      : { errors: [createError(filePath, "invalid_action", `${path}.command must be a string or { name, args? }.`, `${path}.command`)] }
  }

  if ("tool" in action) {
    const tool = parseToolAction(action.tool)
    return tool
      ? { action: { tool }, errors: [] }
      : { errors: [createError(filePath, "invalid_action", `${path}.tool must be { name, args? }.`, `${path}.tool`)] }
  }

  const bash = parseBashAction(action.bash)
  return bash
    ? { action: { bash }, errors: [] }
    : { errors: [createError(filePath, "invalid_action", `${path}.bash must be a string or { command, timeout? }.`, `${path}.bash`)] }
}

function parseCommandAction(value: unknown): string | HookCommandActionConfig | undefined {
  if (isNonEmptyString(value)) {
    return value
  }

  if (!isRecord(value) || !isNonEmptyString(value.name)) {
    return undefined
  }

  if (value.args !== undefined && typeof value.args !== "string") {
    return undefined
  }

  return value.args !== undefined ? { name: value.name, args: value.args } : { name: value.name }
}

function parseToolAction(value: unknown): HookToolActionConfig | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.name)) {
    return undefined
  }

  if (value.args !== undefined && !isRecord(value.args)) {
    return undefined
  }

  return value.args !== undefined ? { name: value.name, args: value.args } : { name: value.name }
}

function parseBashAction(value: unknown): string | HookBashActionConfig | undefined {
  if (isNonEmptyString(value)) {
    return value
  }

  if (!isRecord(value) || !isNonEmptyString(value.command)) {
    return undefined
  }

  const timeout = value.timeout
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0)) {
    return undefined
  }

  return timeout !== undefined ? { command: value.command, timeout } : { command: value.command }
}

function createError(filePath: string, code: HookValidationError["code"], message: string, errorPath?: string): HookValidationError {
  return {
    code,
    filePath,
    message,
    ...(errorPath ? { path: errorPath } : {}),
  }
}

function defaultReadFile(filePath: string): string {
  return readFileSync(filePath, "utf8")
}

function formatHookReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Failed to read hooks.yaml: ${message}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function parseHookId(filePath: string, id: unknown, index: number, seenIds: Set<string>): { id?: string; errors: HookValidationError[] } {
  if (id === undefined) {
    return { errors: [] }
  }

  if (!isNonEmptyString(id)) {
    return {
      errors: [createError(filePath, "invalid_hook", `hooks[${index}].id must be a non-empty string.`, `hooks[${index}].id`)],
    }
  }

  if (seenIds.has(id)) {
    return {
      id,
      errors: [createError(filePath, "duplicate_hook_id", `hooks[${index}].id duplicates hook id \"${id}\" within the same file.`, `hooks[${index}].id`)],
    }
  }

  seenIds.add(id)
  return { id, errors: [] }
}

function parseOverrideTarget(
  filePath: string,
  override: unknown,
  disable: unknown,
  index: number,
): { targetId?: string; isDisableOverride: boolean; errors: HookValidationError[] } {
  const errors: HookValidationError[] = []

  if (override !== undefined && !isNonEmptyString(override)) {
    errors.push(createError(filePath, "invalid_override", `hooks[${index}].override must be a non-empty string.`, `hooks[${index}].override`))
  }

  if (disable !== undefined && typeof disable !== "boolean") {
    errors.push(createError(filePath, "invalid_override", `hooks[${index}].disable must be a boolean.`, `hooks[${index}].disable`))
  }

  const targetId = isNonEmptyString(override) ? override : undefined
  const isDisableOverride = targetId !== undefined && disable === true && errors.length === 0

  return { targetId, isDisableOverride, errors }
}

function flattenHookMap(hooks: HookMap): HookConfig[] {
  return Array.from(hooks.values()).flat()
}

function toHookMap(hooks: HookConfig[]): HookMap {
  const hookMap = new Map<HookConfig["event"], HookConfig[]>()
  for (const hook of hooks) {
    const existing = hookMap.get(hook.event) ?? []
    hookMap.set(hook.event, [...existing, hook])
  }

  return hookMap
}

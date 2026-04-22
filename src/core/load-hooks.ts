import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

import YAML from "yaml"

import {
  type HookAction,
  type HookAsyncConfig,
  type HookBashActionConfig,
  type HookBehavior,
  type HookCommandActionConfig,
  type HookCondition,
  type HookConfig,
  type HookConfirmActionConfig,
  type HookNotifyActionConfig,
  type HookNotifyLevel,
  type HookOverrideEntry,
  type HookRunIn,
  type HookScope,
  type HookMap,
  type HookPathConditionKey,
  type HookSetStatusActionConfig,
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
import {
  discoverHookConfigEntries,
  type DiscoveredHookConfigPath,
  type HookConfigDiscoveryOptions,
  type HookConfigSourceScope,
} from "./config-paths.js"
import { collectUnsupportedDiagnostics } from "../pi/unsupported.js"

export interface HookSourceSummary {
  readonly scope: HookConfigSourceScope
  readonly filePath: string
  readonly hookCount: number
}

export interface HookDiscoveryResult {
  readonly hooks: HookMap
  readonly errors: HookValidationError[]
  readonly files: string[]
  readonly sources: HookSourceSummary[]
}

export interface HookLoadOptions extends HookConfigDiscoveryOptions {
  readonly readFile?: (filePath: string) => string
}

export interface HookLoadSnapshot extends HookDiscoveryResult {
  readonly signature: string
}

type ParsedHooksFileResult = ParsedHooksFile & { readonly files: string[] }
type DiscoveredHooksFileSnapshot =
  | { readonly scope: HookConfigSourceScope; readonly filePath: string; readonly content: string }
  | { readonly scope: HookConfigSourceScope; readonly filePath: string; readonly readError: string }

interface ParsedHooksFileEnvelope {
  readonly imports: string[]
  readonly body?: Record<string, unknown>
  readonly errors: HookValidationError[]
}

const nodeRequire = createRequire(import.meta.url)

export function parseHooksFile(filePath: string, content: string): ParsedHooksFileResult {
  const envelope = parseHooksFileEnvelope(filePath, content)
  if (envelope.errors.length > 0 || !envelope.body) {
    return {
      hooks: new Map(),
      overrides: [],
      errors: envelope.errors,
      files: [filePath],
    }
  }

  return parseHooksObject(filePath, envelope.body)
}

function parseHooksFileEnvelope(filePath: string, content: string): ParsedHooksFileEnvelope {
  const document = YAML.parseDocument(content)
  if (document.errors.length > 0) {
    return {
      imports: [],
      errors: [{ code: "invalid_frontmatter", filePath, message: document.errors[0]?.message ?? "Failed to parse hooks.yaml." }],
    }
  }

  const parsed = document.toJS()

  if (!isRecord(parsed)) {
    return {
      imports: [],
      errors: [{ code: "invalid_frontmatter", filePath, message: "hooks.yaml must parse to an object." }],
    }
  }

  const importsResult = parseImportsField(filePath, parsed.imports)
  if (importsResult.error) {
    return { imports: [], errors: [importsResult.error] }
  }

  return { imports: importsResult.imports, body: parsed, errors: [] }
}

function parseHooksObject(filePath: string, parsed: Record<string, unknown>): ParsedHooksFileResult {
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

  const piDiagnostics = collectUnsupportedDiagnostics(hooks)
  for (const message of piDiagnostics.errors) {
    errors.push({ code: "unsupported_on_pi", filePath, message })
  }

  // P1 #2 fix: drop hooks that produced unsupported_on_pi errors so the
  // runtime never executes them. The errors above remain so operators see
  // why their hook was skipped.
  if (piDiagnostics.invalidHooks.size > 0) {
    for (const [event, hookList] of hooks) {
      const filtered = hookList.filter((hook) => !piDiagnostics.invalidHooks.has(hook))
      if (filtered.length === 0) {
        hooks.delete(event)
      } else if (filtered.length !== hookList.length) {
        hooks.set(event, filtered)
      }
    }
  }

  if (piDiagnostics.advisories.length > 0) {
    for (const advisory of piDiagnostics.advisories) {
      // Surface advisories so operators see them even without inspecting
      // ParsedHooksFile.advisories directly.
      // eslint-disable-next-line no-console
      console.info(`[pi-hooks] ${advisory}`)
    }
  }

  return {
    hooks,
    overrides,
    errors,
    ...(piDiagnostics.advisories.length > 0 ? { advisories: piDiagnostics.advisories } : {}),
    files: [filePath],
  }
}

function parseImportsField(
  filePath: string,
  imports: unknown,
): { imports: string[]; error?: undefined } | { imports?: undefined; error: HookValidationError } {
  if (imports === undefined) {
    return { imports: [] }
  }

  if (!Array.isArray(imports)) {
    return {
      error: createError(filePath, "invalid_imports", "imports must be an array of non-empty strings.", "imports"),
    }
  }

  const invalidIndex = imports.findIndex((entry) => !isNonEmptyString(entry))
  if (invalidIndex >= 0) {
    return {
      error: createError(filePath, "invalid_imports", `imports[${invalidIndex}] must be a non-empty string.`, `imports[${invalidIndex}]`),
    }
  }

  return { imports: [...imports] }
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
  const entries = discoverHookConfigEntries(options)
  return loadDiscoveredHooksFromFiles(entries, options)
}

// P1 #10 fix: cache the last parsed snapshot keyed on a cheap stat-based
// fingerprint so the hot-path dispatcher does not re-read + re-parse every
// hooks.yaml on every tool call. Cache is bounded to one entry per (file
// list + fingerprint) tuple — typically just one entry in practice.
interface CachedSnapshot {
  signature: string
  result: HookDiscoveryResult
}
const snapshotCache = new Map<string, CachedSnapshot>()

export function loadDiscoveredHooksSnapshot(options: HookLoadOptions = {}): HookLoadSnapshot {
  const entries = discoverHookConfigEntries(options)
  const snapshots = snapshotDiscoveredHookFiles(entries, options.readFile ?? defaultReadFile)
  const result = loadDiscoveredHooksFromSnapshots(snapshots)
  const fingerprintSignature = computeFingerprintSignature(result.files)
  const cacheKey = entries.map((entry) => entry.filePath).join("\0")
  const cached = snapshotCache.get(cacheKey)
  if (cached && cached.signature === fingerprintSignature) {
    return { ...cached.result, signature: cached.signature }
  }

  snapshotCache.set(cacheKey, { signature: fingerprintSignature, result })
  return { ...result, signature: fingerprintSignature }
}

function computeFingerprintSignature(files: readonly string[]): string {
  const parts: string[] = []
  for (const filePath of files) {
    try {
      const stat = statSync(filePath)
      parts.push(`${filePath}|${stat.mtimeMs}|${stat.size}`)
    } catch {
      parts.push(`${filePath}|missing`)
    }
  }
  return parts.join("\n")
}

function loadDiscoveredHooksFromFiles(entries: DiscoveredHookConfigPath[], options: HookLoadOptions): HookDiscoveryResult {
  const readFile = options.readFile ?? defaultReadFile
  const snapshots = snapshotDiscoveredHookFiles(entries, readFile)

  return loadDiscoveredHooksFromSnapshots(snapshots)
}

function loadDiscoveredHooksFromSnapshots(snapshots: readonly DiscoveredHooksFileSnapshot[]): HookDiscoveryResult {
  const hooks = new Map<HookConfig["event"], HookConfig[]>()
  const errors: HookValidationError[] = []
  const sources: HookSourceSummary[] = []
  const files: string[] = []
  const loadedFiles = new Set<string>()

  for (const snapshot of snapshots) {
    const expanded = expandSnapshotImports(snapshot, loadedFiles)
    errors.push(...expanded.errors)

    for (const entry of expanded.snapshots) {
      files.push(entry.filePath)
      const result = loadSnapshotHooksFile(entry)
      const resolved = resolveOverrides(hooks, result.overrides)
      hooks.clear()
      mergeHookMapsInto(hooks, resolved.hooks)
      mergeHookMapsInto(hooks, result.hooks)
      errors.push(...resolved.errors)
      errors.push(...result.errors)
      sources.push({
        scope: entry.scope,
        filePath: entry.filePath,
        hookCount: countHookConfigs(result.hooks),
      })
    }
  }

  errors.push(...validateAsyncQueueConfigs(hooks))

  return { hooks, errors, files, sources }
}

function validateAsyncQueueConfigs(hooks: HookMap): HookValidationError[] {
  const errors: HookValidationError[] = []
  const concurrencyByGroup = new Map<string, number>()

  for (const hook of flattenHookMap(hooks)) {
    if (!hook.async || hook.async === true) {
      continue
    }

    const pathBase = `hooks[${hook.source.index}].async`
    if (hook.async.concurrency !== undefined && hook.async.group === undefined) {
      errors.push(
        createError(
          hook.source.filePath,
          "invalid_async",
          `${pathBase}.concurrency requires async.group so legacy per-event async queues stay serialized by default.`,
          `${pathBase}.concurrency`,
        ),
      )
    }

    if (!hook.async.group) {
      continue
    }

    const expected = concurrencyByGroup.get(hook.async.group)
    const actual = hook.async.concurrency ?? 1
    if (expected !== undefined && expected !== actual) {
      errors.push(
        createError(
          hook.source.filePath,
          "invalid_async",
          `${pathBase}.concurrency for group ${JSON.stringify(hook.async.group)} must match earlier hooks in that group (${expected}).`,
          `${pathBase}.concurrency`,
        ),
      )
      continue
    }

    concurrencyByGroup.set(hook.async.group, actual)
  }

  return errors
}

function expandSnapshotImports(
  snapshot: DiscoveredHooksFileSnapshot,
  loadedFiles: Set<string>,
): { snapshots: DiscoveredHooksFileSnapshot[]; errors: HookValidationError[] } {
  const ordered: DiscoveredHooksFileSnapshot[] = []
  const errors: HookValidationError[] = []
  const visiting = new Set<string>()

  const visit = (current: DiscoveredHooksFileSnapshot): void => {
    const canonicalPath = canonicalizeHookPath(current.filePath)
    if (loadedFiles.has(canonicalPath)) {
      return
    }
    if (visiting.has(canonicalPath)) {
      errors.push(createError(current.filePath, "invalid_imports", `Import cycle detected involving ${current.filePath}.`, "imports"))
      return
    }

    visiting.add(canonicalPath)
    const imports = readSnapshotImports(current, errors)
    for (const imported of imports) {
      visit(imported)
    }
    visiting.delete(canonicalPath)

    if (!loadedFiles.has(canonicalPath)) {
      loadedFiles.add(canonicalPath)
      ordered.push(current)
    }
  }

  visit(snapshot)
  return { snapshots: ordered, errors }
}

function readSnapshotImports(snapshot: DiscoveredHooksFileSnapshot, errors: HookValidationError[]): DiscoveredHooksFileSnapshot[] {
  if (!("content" in snapshot)) {
    return []
  }

  const envelope = parseHooksFileEnvelope(snapshot.filePath, snapshot.content)
  errors.push(...envelope.errors)
  if (envelope.errors.length > 0) {
    return []
  }

  const imports: DiscoveredHooksFileSnapshot[] = []
  for (const specifier of envelope.imports) {
    const resolved = resolveHookImportTargets(snapshot.filePath, specifier)
    if (resolved.error) {
      errors.push(resolved.error)
      continue
    }
    for (const filePath of resolved.filePaths) {
      try {
        imports.push({ scope: snapshot.scope, filePath, content: defaultReadFile(filePath) })
      } catch (error) {
        imports.push({ scope: snapshot.scope, filePath, readError: formatHookReadError(error) })
      }
    }
  }

  return imports
}

function resolveHookImportTargets(
  importerPath: string,
  specifier: string,
): { filePaths: string[]; error?: undefined } | { filePaths?: undefined; error: HookValidationError } {
  try {
    const resolvedPath = specifier.startsWith(".") || specifier.startsWith("/")
      ? path.resolve(path.dirname(importerPath), specifier)
      : createRequire(importerPath).resolve(specifier, { paths: [path.dirname(importerPath)] })
    return { filePaths: expandHookImportPath(resolvedPath) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      error: createError(importerPath, "invalid_imports", `Failed to resolve import ${JSON.stringify(specifier)}: ${detail}`, "imports"),
    }
  }
}

function expandHookImportPath(resolvedPath: string): string[] {
  const stat = statSync(resolvedPath)
  if (stat.isDirectory()) {
    return readdirSync(resolvedPath)
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((entry) => path.join(resolvedPath, entry))
      .filter((entryPath) => statSync(entryPath).isFile())
  }
  return [resolvedPath]
}

function canonicalizeHookPath(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

function snapshotDiscoveredHookFiles(
  entries: readonly DiscoveredHookConfigPath[],
  readFile: (filePath: string) => string,
): DiscoveredHooksFileSnapshot[] {
  return entries.map(({ scope, filePath }) => {
    try {
      return { scope, filePath, content: readFile(filePath) }
    } catch (error) {
      return { scope, filePath, readError: formatHookReadError(error) }
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

export interface HookLoadSummary {
  readonly global: number
  readonly project: number
  readonly total: number
}

export function summarizeHookSources(sources: readonly HookSourceSummary[]): HookLoadSummary {
  let global = 0
  let project = 0

  for (const source of sources) {
    if (source.scope === "global") {
      global += source.hookCount
    } else {
      project += source.hookCount
    }
  }

  return { global, project, total: global + project }
}

export function formatHookLoadSummary(result: Pick<HookDiscoveryResult, "sources">): string {
  const summary = summarizeHookSources(result.sources)
  const label = summary.total === 1 ? "hook" : "hooks"
  return `[pi-hooks] Loaded ${summary.total} ${label} (global: ${summary.global}, project: ${summary.project}).`
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
    ...(asyncResult.async ? { async: asyncResult.async } : {}),
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

function parseAsync(
  filePath: string,
  async_: unknown,
  event: unknown,
  actions: unknown,
  index: number,
): { async?: true | HookAsyncConfig; errors: HookValidationError[] } {
  if (async_ === undefined) {
    return { errors: [] }
  }

  const normalized = normalizeAsyncConfig(filePath, async_, index)
  if (normalized.errors.length > 0 || !normalized.enabled) {
    return {
      errors: normalized.errors,
    }
  }

  if (typeof event === "string" && event.startsWith("tool.before")) {
    return {
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async cannot be true for tool.before events because blocking requires synchronous execution.`, `hooks[${index}].async`)],
    }
  }

  if (typeof event === "string" && event === "session.idle") {
    return {
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async cannot be true for session.idle events because idle dispatch must complete before tracked changes are consumed.`, `hooks[${index}].async`)],
    }
  }

  if (Array.isArray(actions) && actions.some((a) => typeof a === "object" && a !== null && ("command" in a || "tool" in a))) {
    return {
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async hooks must use only bash actions. command and tool actions have no timeout and can stall the async queue.`, `hooks[${index}].async`)],
    }
  }

  return { async: normalized.config, errors: [] }
}

function normalizeAsyncConfig(
  filePath: string,
  value: unknown,
  index: number,
): { enabled: boolean; config?: true | HookAsyncConfig; errors: HookValidationError[] } {
  if (value === false) {
    return { enabled: false, errors: [] }
  }

  if (value === true) {
    return { enabled: true, config: true, errors: [] }
  }

  if (!isRecord(value)) {
    return {
      enabled: false,
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async must be a boolean or { group?, concurrency? }.`, `hooks[${index}].async`)],
    }
  }

  const group = value.group
  if (group !== undefined && !isNonEmptyString(group)) {
    return {
      enabled: false,
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async.group must be a non-empty string.`, `hooks[${index}].async.group`)],
    }
  }

  const concurrency = value.concurrency
  if (
    concurrency !== undefined &&
    (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency <= 0)
  ) {
    return {
      enabled: false,
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async.concurrency must be a positive integer.`, `hooks[${index}].async.concurrency`)],
    }
  }

  if (Object.keys(value).some((key) => key !== "group" && key !== "concurrency")) {
    return {
      enabled: false,
      errors: [createError(filePath, "invalid_async", `hooks[${index}].async only supports group and concurrency.`, `hooks[${index}].async`)],
    }
  }

  const config: HookAsyncConfig = {
    ...(group !== undefined ? { group } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  }

  return { enabled: true, config: Object.keys(config).length > 0 ? config : true, errors: [] }
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

  const keys = ["command", "tool", "bash", "notify", "confirm", "setStatus"].filter((key) => key in action)
  if (keys.length !== 1) {
    return {
      errors: [
        createError(
          filePath,
          "invalid_action",
          `${path} must define exactly one of command, tool, bash, notify, confirm, or setStatus.`,
          path,
        ),
      ],
    }
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

  if ("notify" in action) {
    const notify = parseNotifyAction(action.notify)
    return notify
      ? { action: { notify }, errors: [] }
      : {
          errors: [
            createError(
              filePath,
              "invalid_action",
              `${path}.notify must be a non-empty string or { text, level? } where level is one of info, success, warning, error.`,
              `${path}.notify`,
            ),
          ],
        }
  }

  if ("confirm" in action) {
    const confirm = parseConfirmAction(action.confirm)
    return confirm
      ? { action: { confirm }, errors: [] }
      : {
          errors: [
            createError(
              filePath,
              "invalid_action",
              `${path}.confirm must be { message, title? } with non-empty message.`,
              `${path}.confirm`,
            ),
          ],
        }
  }

  if ("setStatus" in action) {
    const setStatus = parseSetStatusAction(action.setStatus)
    return setStatus
      ? { action: { setStatus }, errors: [] }
      : {
          errors: [
            createError(
              filePath,
              "invalid_action",
              `${path}.setStatus must be a non-empty string or { text } with non-empty text.`,
              `${path}.setStatus`,
            ),
          ],
        }
  }

  const bash = parseBashAction(action.bash)
  return bash
    ? { action: { bash }, errors: [] }
    : { errors: [createError(filePath, "invalid_action", `${path}.bash must be a string or { command, timeout? }.`, `${path}.bash`)] }
}

function parseNotifyAction(value: unknown): string | HookNotifyActionConfig | undefined {
  if (isNonEmptyString(value)) {
    return value
  }

  if (!isRecord(value) || !isNonEmptyString(value.text)) {
    return undefined
  }

  if (value.level === undefined) {
    return { text: value.text }
  }

  if (!isHookNotifyLevel(value.level)) {
    return undefined
  }

  return { text: value.text, level: value.level }
}

function parseConfirmAction(value: unknown): HookConfirmActionConfig | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.message)) {
    return undefined
  }

  if (value.title !== undefined && !isNonEmptyString(value.title)) {
    return undefined
  }

  return value.title !== undefined ? { title: value.title, message: value.message } : { message: value.message }
}

function parseSetStatusAction(value: unknown): string | HookSetStatusActionConfig | undefined {
  if (isNonEmptyString(value)) {
    return value
  }

  if (!isRecord(value) || !isNonEmptyString(value.text)) {
    return undefined
  }

  return { text: value.text }
}

function isHookNotifyLevel(value: unknown): value is HookNotifyLevel {
  return value === "info" || value === "success" || value === "warning" || value === "error"
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

function countHookConfigs(hooks: HookMap): number {
  return flattenHookMap(hooks).length
}

function toHookMap(hooks: HookConfig[]): HookMap {
  const hookMap = new Map<HookConfig["event"], HookConfig[]>()
  for (const hook of hooks) {
    const existing = hookMap.get(hook.event) ?? []
    hookMap.set(hook.event, [...existing, hook])
  }

  return hookMap
}

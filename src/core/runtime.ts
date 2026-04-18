import { AsyncLocalStorage } from "node:async_hooks"
import { extname, isAbsolute, matchesGlob, relative } from "node:path"

import { executeBashHook } from "./bash-executor.js"
import type { BashExecutionRequest, BashHookResult } from "./bash-types.js"
import { loadDiscoveredHooksSnapshot } from "./load-hooks.js"
import { SessionStateStore } from "./session-state.js"
import { getChangedPaths, getMutationToolHookNames, getToolFileChanges } from "./tool-paths.js"
import type {
  FileChange,
  HookAction,
  HookConfig,
  HookEvent,
  HookMap,
  HookRunIn,
  HookValidationError,
  HostAdapter,
} from "./types.js"

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".json5",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".astro",
  ".mdx",
  ".graphql",
  ".gql",
  ".proto",
  ".sql",
  ".prisma",
  ".go",
  ".rs",
  ".zig",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".java",
  ".groovy",
  ".gradle",
  ".py",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".psm1",
  ".psd1",
  ".bat",
  ".cmd",
  ".kt",
  ".kts",
  ".swift",
  ".m",
  ".mm",
  ".cs",
  ".fs",
  ".scala",
  ".clj",
  ".hs",
  ".lua",
  ".dart",
  ".elm",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".nim",
  ".nix",
  ".r",
  ".rkt",
  ".tf",
  ".tfvars",
])

export interface ToolExecuteBeforeInput {
  readonly tool: string
  readonly sessionID?: string
  readonly callID: string
}

export interface ToolExecuteBeforeOutput {
  readonly args?: Record<string, unknown>
}

export interface ToolExecuteAfterInput {
  readonly tool: string
  readonly sessionID?: string
  readonly callID: string
  readonly args?: Record<string, unknown>
}

export interface RuntimeEventEnvelope {
  readonly event: {
    readonly type: string
    readonly properties?: Record<string, unknown>
  }
}

interface RuntimeActionContext {
  readonly files?: readonly string[]
  readonly changes?: readonly FileChange[]
  readonly toolName?: string
  readonly toolArgs?: Record<string, unknown>
  readonly sourceSessionID?: string
  readonly targetSessionID?: string
}

interface HookExecutionResult {
  readonly blocked: boolean
  readonly blockReason?: string
  readonly stopSession?: boolean
}

interface DispatchState {
  active: boolean
  pending: DispatchRequest[]
}

interface DispatchRequest {
  readonly context: RuntimeActionContext
  readonly options: { canBlock?: boolean }
  readonly resolve?: (result: HookExecutionResult) => void
  readonly reject?: (error: unknown) => void
}

type ExecuteBashHook = (request: BashExecutionRequest) => Promise<BashHookResult>

export interface HooksRuntime {
  readonly "tool.execute.before": (
    input: ToolExecuteBeforeInput,
    output: ToolExecuteBeforeOutput,
  ) => Promise<void>
  readonly "tool.execute.after": (
    input: ToolExecuteAfterInput,
    output?: unknown,
  ) => Promise<void>
  readonly event: (envelope: RuntimeEventEnvelope) => Promise<void>
}

export interface CreateHooksRuntimeOptions {
  readonly directory: string
  readonly hooks?: HookMap
  readonly executeBash?: ExecuteBashHook
}

export function createHooksRuntime(host: HostAdapter, options: CreateHooksRuntimeOptions): HooksRuntime {
  const projectDir = options.directory

  let loaded = options.hooks
    ? { hooks: options.hooks, errors: [] as HookValidationError[], signature: "manual" }
    : loadDiscoveredHooksSnapshot({ projectDir })
  if (loaded.errors.length > 0) {
    console.error(formatHookLoadErrors(loaded.errors))
  }

  let hooks = loaded.hooks
  let lastLoadedSignature = loaded.signature
  let lastReportedInvalidSignature = loaded.errors.length > 0 ? loaded.signature : undefined
  const state = new SessionStateStore()
  const runBashHook: ExecuteBashHook = options.executeBash ?? ((request) => host.runBash(request))
  const dispatchStates = new Map<string, DispatchState>()
  const asyncQueues = new Map<string, Promise<void>>()
  const actionRecursionGuards = new AsyncLocalStorage<Set<string>>()

  function refreshHooks(): HookMap {
    if (options.hooks) {
      return hooks
    }

    const nextLoaded = loadDiscoveredHooksSnapshot({ projectDir })
    if (nextLoaded.signature === lastLoadedSignature) {
      return hooks
    }

    lastLoadedSignature = nextLoaded.signature
    if (nextLoaded.errors.length > 0) {
      if (lastReportedInvalidSignature !== nextLoaded.signature) {
        console.error(formatHookReloadErrors(nextLoaded.errors))
        lastReportedInvalidSignature = nextLoaded.signature
      }
      return hooks
    }

    hooks = nextLoaded.hooks
    lastReportedInvalidSignature = undefined
    return hooks
  }

  return {
    "tool.execute.before": async (
      eventInput: ToolExecuteBeforeInput,
      eventOutput: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      const activeHooks = refreshHooks()
      const sessionID = eventInput.sessionID
      if (!sessionID) {
        return
      }

      const toolArgs = eventOutput.args ?? {}
      state.setPendingToolCall(eventInput.callID, sessionID, toolArgs)

      const result = await dispatchToolHooks(
        activeHooks,
        state,
        host,
        projectDir,
        runBashHook,
        dispatchStates,
        actionRecursionGuards,
        asyncQueues,
        "before",
        eventInput.tool,
        sessionID,
        {
          toolName: eventInput.tool,
          toolArgs,
        },
      )

      if (result.blocked) {
        state.consumePendingToolCall(eventInput.callID)
        if (result.stopSession) {
          await abortSession(host, sessionID)
        }
        throw new Error(result.blockReason ?? "Blocked by hook")
      }
    },

    "tool.execute.after": async (
      eventInput: ToolExecuteAfterInput,
      _eventOutput?: unknown,
    ): Promise<void> => {
      const activeHooks = refreshHooks()
      const sessionID = eventInput.sessionID
      if (!sessionID) {
        return
      }

      const pending = state.consumePendingToolCall(eventInput.callID)
      const toolArgs = resolveToolArgs(eventInput.args, pending?.toolArgs)
      const changes = getToolFileChanges(eventInput.tool, toolArgs)
      const files = changes.length > 0 ? getChangedPaths(changes) : undefined

      state.addFileChanges(sessionID, changes)

      if (changes.length > 0) {
        await dispatchHooks(
          activeHooks,
          state,
          host,
          projectDir,
          runBashHook,
          "file.changed",
          sessionID,
          {
            files,
            changes,
            toolName: eventInput.tool,
            toolArgs,
          },
          {},
          dispatchStates,
          actionRecursionGuards,
          asyncQueues,
        )
      }

      await dispatchToolHooks(
        activeHooks,
        state,
        host,
        projectDir,
        runBashHook,
        dispatchStates,
        actionRecursionGuards,
        asyncQueues,
        "after",
        eventInput.tool,
        sessionID,
        {
          files,
          changes,
          toolName: eventInput.tool,
          toolArgs,
        },
      )
    },

    event: async ({ event }: RuntimeEventEnvelope): Promise<void> => {
      const activeHooks = refreshHooks()
      const properties = event.properties ?? {}

      if (event.type === "session.created") {
        const info = asRecord(properties.info)
        const sessionID = pickString(info?.id)
        if (!sessionID) {
          return
        }

        state.rememberSession(sessionID, pickString(info?.parentID) ?? null)
        await dispatchHooks(
          activeHooks,
          state,
          host,
          projectDir,
          runBashHook,
          "session.created",
          sessionID,
          {},
          {},
          dispatchStates,
          actionRecursionGuards,
          asyncQueues,
        )
        return
      }

      if (event.type === "session.deleted") {
        const info = asRecord(properties.info)
        const sessionID = pickString(info?.id)
        if (!sessionID) {
          return
        }

        state.rememberSession(sessionID, pickString(info?.parentID) ?? undefined)
        state.deleteSession(sessionID)
        await dispatchHooks(
          activeHooks,
          state,
          host,
          projectDir,
          runBashHook,
          "session.deleted",
          sessionID,
          {},
          {},
          dispatchStates,
          actionRecursionGuards,
          asyncQueues,
        )
        return
      }

      if (event.type === "session.idle") {
        const sessionID = pickString(properties.sessionID)
        if (!sessionID) {
          return
        }

        const changes = state.getFileChanges(sessionID)
        const files = state.getModifiedPaths(sessionID)
        state.beginIdleDispatch(sessionID, changes)

        try {
          await dispatchHooks(
            activeHooks,
            state,
            host,
            projectDir,
            runBashHook,
            "session.idle",
            sessionID,
            { files, changes },
            {},
            dispatchStates,
            actionRecursionGuards,
            asyncQueues,
          )
          state.consumeFileChanges(sessionID, changes)
        } catch (error) {
          state.cancelIdleDispatch(sessionID)
          throw error
        }
      }
    },
  }
}

async function dispatchToolHooks(
  hooks: HookMap,
  state: SessionStateStore,
  host: HostAdapter,
  projectDir: string,
  runBashHook: ExecuteBashHook,
  dispatchStates: Map<string, DispatchState>,
  actionRecursionGuards: AsyncLocalStorage<Set<string>>,
  asyncQueues: Map<string, Promise<void>>,
  phase: "before" | "after",
  toolName: string,
  sessionID: string,
  context: RuntimeActionContext,
): Promise<HookExecutionResult> {
  const wildcardResult = await dispatchHooks(
    hooks,
    state,
    host,
    projectDir,
    runBashHook,
    `tool.${phase}.*`,
    sessionID,
    context,
    { canBlock: phase === "before" },
    dispatchStates,
    actionRecursionGuards,
    asyncQueues,
  )
  if (wildcardResult.blocked) {
    return wildcardResult
  }

  for (const resolvedToolName of getMutationToolHookNames(toolName).length > 0 ? getMutationToolHookNames(toolName) : [toolName]) {
    const result = await dispatchHooks(
      hooks,
      state,
      host,
      projectDir,
      runBashHook,
      `tool.${phase}.${resolvedToolName}`,
      sessionID,
      context,
      { canBlock: phase === "before" },
      dispatchStates,
      actionRecursionGuards,
      asyncQueues,
    )

    if (result.blocked) {
      return result
    }
  }

  return { blocked: false }
}

async function dispatchHooks(
  hooks: HookMap,
  state: SessionStateStore,
  host: HostAdapter,
  projectDir: string,
  runBashHook: ExecuteBashHook,
  event: HookEvent,
  sessionID: string,
  context: RuntimeActionContext = {},
  options: { canBlock?: boolean } = {},
  dispatchStates: Map<string, DispatchState>,
  actionRecursionGuards: AsyncLocalStorage<Set<string>>,
  asyncQueues: Map<string, Promise<void>>,
): Promise<HookExecutionResult> {
  const eventHooks = hooks.get(event)
  if (!eventHooks || eventHooks.length === 0) {
    return { blocked: false }
  }

  const hooksForEvent = eventHooks

  const dispatchKey = `${event}:${sessionID}`
  const dispatchState = dispatchStates.get(dispatchKey)
  if (dispatchState?.active) {
    if (!options.canBlock) {
      dispatchState.pending.push({ context, options })
      return { blocked: false }
    }

    return await new Promise<HookExecutionResult>((resolve, reject) => {
      dispatchState.pending.push({ context, options, resolve, reject })
    })
  }

  const currentState = dispatchState ?? { active: false, pending: [] }
  currentState.active = true
  dispatchStates.set(dispatchKey, currentState)

  let currentResult: HookExecutionResult = { blocked: false }
  let currentError: unknown

  try {
    currentResult = await executeDispatchRequest({ context, options })
  } catch (error) {
    currentError = error
  }

  if (currentState.pending.length > 0) {
    if (!options.canBlock) {
      await drainPendingRequests()
    } else {
      setTimeout(() => {
        void drainPendingRequests()
      }, 0)
    }
  } else {
    currentState.active = false
    currentState.pending = []
    dispatchStates.delete(dispatchKey)
  }

  if (currentError !== undefined) {
    throw currentError
  }

  return currentResult

  async function executeDispatchRequest(request: DispatchRequest): Promise<HookExecutionResult> {
    for (const hook of hooksForEvent) {
      const result = await executeHook(
        hook,
        state,
        host,
        projectDir,
        runBashHook,
        sessionID,
        request.context,
        request.options,
        actionRecursionGuards,
        asyncQueues,
      )
      if (result.blocked) {
        return result
      }
    }

    return { blocked: false }
  }

  async function drainPendingRequests(): Promise<void> {
    try {
      while (currentState.pending.length > 0) {
        const request = currentState.pending.shift()!

        try {
          const result = await executeDispatchRequest(request)
          request.resolve?.(result)
        } catch (error) {
          request.reject?.(error)
        }
      }
    } finally {
      currentState.active = false
      currentState.pending = []
      dispatchStates.delete(dispatchKey)
    }
  }
}

async function executeHook(
  hook: HookConfig,
  state: SessionStateStore,
  host: HostAdapter,
  projectDir: string,
  runBashHook: ExecuteBashHook,
  sessionID: string,
  context: RuntimeActionContext,
  options: { canBlock?: boolean },
  actionRecursionGuards: AsyncLocalStorage<Set<string>>,
  asyncQueues: Map<string, Promise<void>>,
): Promise<HookExecutionResult> {
  try {
    if (!(await shouldRunHook(hook, state, host, projectDir, sessionID, context))) {
      return { blocked: false }
    }
  } catch (error) {
    logHookFailure(hook.event, hook.source.filePath, error)
    return { blocked: false }
  }

  if (hook.async) {
    const queueKey = `${hook.event}:${sessionID}`
    const previous = asyncQueues.get(queueKey) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        for (const action of hook.actions) {
          await executeAction(
            action,
            hook.runIn,
            host,
            projectDir,
            state,
            runBashHook,
            hook.event,
            sessionID,
            context,
            hook.source.filePath,
            actionRecursionGuards,
          )
        }
      })
      .catch((error) => {
        logHookFailure(hook.event, hook.source.filePath, error)
      })
      .finally(() => {
        if (asyncQueues.get(queueKey) === next) {
          asyncQueues.delete(queueKey)
        }
      })
    asyncQueues.set(queueKey, next)
    return { blocked: false }
  }

  for (const action of hook.actions) {
    const result = await executeAction(
      action,
      hook.runIn,
      host,
      projectDir,
      state,
      runBashHook,
      hook.event,
      sessionID,
      context,
      hook.source.filePath,
      actionRecursionGuards,
    )
    if (result.blocked && options.canBlock) {
      return {
        ...result,
        ...(hook.action === "stop" ? { stopSession: true } : {}),
      }
    }
  }

  return { blocked: false }
}

async function shouldRunHook(
  hook: HookConfig,
  state: SessionStateStore,
  host: HostAdapter,
  projectDir: string,
  sessionID: string,
  context: RuntimeActionContext,
): Promise<boolean> {
  if (!(await state.evaluateScope(sessionID, hook.scope, (currentSessionID) => resolveParentSessionID(host, currentSessionID)))) {
    return false
  }

  const changedPaths = getFinalChangedPaths(projectDir, context)

  for (const condition of hook.conditions ?? []) {
    if (condition === "matchesCodeFiles") {
      if (!(context.files ?? []).some(hasCodeExtension)) {
        return false
      }

      continue
    }

    if ("matchesAnyPath" in condition) {
      if (changedPaths.length === 0) {
        return false
      }

      if (!changedPaths.some((filePath) => condition.matchesAnyPath.some((pattern) => matchesGlob(filePath, pattern)))) {
        return false
      }

      continue
    }

    if (changedPaths.length === 0) {
      return false
    }

    if (!changedPaths.every((filePath) => condition.matchesAllPaths.some((pattern) => matchesGlob(filePath, pattern)))) {
      return false
    }
  }

  return true
}

function getFinalChangedPaths(projectDir: string, context: RuntimeActionContext): readonly string[] {
  if (context.changes && context.changes.length > 0) {
    return context.changes.map((change) => normalizeConditionPath(projectDir, change.operation === "rename" ? change.toPath : change.path))
  }

  return (context.files ?? []).map((filePath) => normalizeConditionPath(projectDir, filePath))
}

function normalizeConditionPath(projectDir: string, filePath: string): string {
  const normalizedPath = normalizeGlobCandidate(filePath)
  if (!isAbsolute(filePath)) {
    return normalizedPath
  }

  const projectRelativePath = normalizeGlobCandidate(relative(projectDir, filePath))
  if (projectRelativePath !== "" && projectRelativePath !== "." && !projectRelativePath.startsWith("../")) {
    return projectRelativePath
  }

  return normalizedPath
}

function normalizeGlobCandidate(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "")
}

async function executeAction(
  action: HookAction,
  runIn: HookRunIn,
  host: HostAdapter,
  projectDir: string,
  state: SessionStateStore,
  runBashHook: ExecuteBashHook,
  event: HookEvent,
  sessionID: string,
  context: RuntimeActionContext,
  sourceFilePath: string,
  actionRecursionGuards: AsyncLocalStorage<Set<string>>,
): Promise<HookExecutionResult> {
  const executionDirectory = projectDir

  if ("command" in action) {
    // PI host does not expose a session-scoped slash-command surface; fail loud
    // so the diagnostics lane surfaces the misconfiguration to the user.
    logHookFailure(
      event,
      sourceFilePath,
      new Error("command: actions are not supported on PI — remove this action or use bash instead"),
    )
    return { blocked: false }
  }

  if ("tool" in action) {
    try {
      const targetSessionID = await resolveActionSessionID(state, host, sessionID, runIn)
      if (!targetSessionID) {
        return { blocked: false }
      }

      const actionKey = `${event}:${targetSessionID}:tool:${sourceFilePath}:${JSON.stringify(action.tool)}`
      await withActionRecursionGuard(actionRecursionGuards, actionKey, async () => {
        // PI degrades tool: actions to a current-session prompt injection: the
        // host queues a user-visible instruction rather than invoking the tool
        // imperatively (which the PI runtime does not support).
        await host.sendPrompt(
          targetSessionID,
          `Use the ${action.tool.name} tool with these arguments: ${JSON.stringify(action.tool.args ?? {})}`,
        )
      })
    } catch (error) {
      logHookFailure(event, sourceFilePath, error)
    }

    return { blocked: false }
  }

  const config = typeof action.bash === "string" ? { command: action.bash } : action.bash
  const result = await runBashHook({
    command: config.command,
    timeout: config.timeout,
    projectDir: executionDirectory,
    context: {
      session_id: sessionID,
      event,
      cwd: executionDirectory,
      files: context.files,
      changes: context.changes,
      tool_name: context.toolName,
      tool_args: context.toolArgs,
    },
  })

  if (result.blocking) {
    return { blocked: true, blockReason: result.stderr.trim() || "Blocked by hook" }
  }

  return { blocked: false }
}

async function resolveActionSessionID(
  state: SessionStateStore,
  host: HostAdapter,
  sessionID: string,
  runIn: HookRunIn,
): Promise<string | undefined> {
  const targetSessionID =
    runIn === "main"
      ? await state.getRootSessionID(sessionID, (currentSessionID) => resolveParentSessionID(host, currentSessionID))
      : sessionID

  return state.isDeleted(targetSessionID) ? undefined : targetSessionID
}

async function abortSession(host: HostAdapter, sessionID: string): Promise<void> {
  try {
    await host.abort(sessionID)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[pi-hooks] Failed to abort session ${sessionID}: ${message}`)
  }
}

async function resolveParentSessionID(host: HostAdapter, sessionID: string): Promise<string | null> {
  // The host only exposes a root-session lookup, so callers that need a parent
  // fall back to "is this already the root?" as a best-effort parent resolver.
  try {
    const rootID = await host.getRootSessionId(sessionID)
    return rootID && rootID !== sessionID ? rootID : null
  } catch {
    return null
  }
}

function hasCodeExtension(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase()
  return Boolean(extension && CODE_EXTENSIONS.has(extension))
}

function formatHookLoadErrors(errors: Array<{ filePath: string; message: string; path?: string }>): string {
  const details = errors.map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
  return `[pi-hooks] Failed to load some hooks; continuing with valid hooks:\n${details.join("\n")}`
}

function formatHookReloadErrors(errors: Array<{ filePath: string; message: string; path?: string }>): string {
  const details = errors.map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
  return `[pi-hooks] Failed to reload hooks.yaml; keeping last known good hooks:\n${details.join("\n")}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function resolveToolArgs(
  eventArgs: Record<string, unknown> | undefined,
  pendingArgs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (eventArgs && Object.keys(eventArgs).length > 0) {
    return eventArgs
  }

  return pendingArgs ?? eventArgs ?? {}
}

function logHookFailure(event: HookEvent, filePath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[pi-hooks] ${event} hook from ${filePath} failed: ${message}`)
}

async function withActionRecursionGuard<T>(
  actionRecursionGuards: AsyncLocalStorage<Set<string>>,
  actionKey: string,
  execute: () => Promise<T>,
): Promise<T | undefined> {
  const activeKeys = actionRecursionGuards.getStore()
  if (activeKeys?.has(actionKey)) {
    return undefined
  }

  if (activeKeys) {
    activeKeys.add(actionKey)
    try {
      return await execute()
    } finally {
      activeKeys.delete(actionKey)
    }
  }

  const rootKeys = new Set<string>([actionKey])
  return await actionRecursionGuards.run(rootKeys, async () => {
    try {
      return await execute()
    } finally {
      rootKeys.delete(actionKey)
    }
  })
}

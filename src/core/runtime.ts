import { AsyncLocalStorage } from "node:async_hooks"
import { extname, isAbsolute, matchesGlob, relative } from "node:path"

import { executeBashHook } from "./bash-executor.js"
import type { BashExecutionRequest, BashHookResult } from "./bash-types.js"
import { loadDiscoveredHooksSnapshot } from "./load-hooks.js"
import { getPiHooksLogger } from "./logger.js"
import { SessionStateStore } from "./session-state.js"
import { getChangedPaths, getMutationToolHookNames, getToolFileChanges } from "./tool-paths.js"
import type {
  FileChange,
  HookAction,
  HookConfig,
  HostDeliveryResult,
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

interface HookMatchDecision {
  readonly matched: boolean
  readonly reason: string
  readonly changedPaths: readonly string[]
  readonly details?: Record<string, unknown>
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
  readonly initialSignature?: string
  readonly reloadDiscoveredHooks?: boolean
  readonly executeBash?: ExecuteBashHook
}

export function createHooksRuntime(host: HostAdapter, options: CreateHooksRuntimeOptions): HooksRuntime {
  const projectDir = options.directory
  const logger = getPiHooksLogger()
  const shouldReloadDiscoveredHooks = options.reloadDiscoveredHooks === true

  let loaded = options.hooks
    ? {
        hooks: options.hooks,
        errors: [] as HookValidationError[],
        signature: options.initialSignature ?? "manual",
      }
    : loadDiscoveredHooksSnapshot({ projectDir })
  if (loaded.errors.length > 0) {
    console.error(formatHookLoadErrors(loaded.errors))
    logger.error("config_load", "Initial hook load reported validation errors.", {
      cwd: projectDir,
      details: {
        errors: loaded.errors.map((error) => ({
          filePath: error.filePath,
          path: error.path,
          message: error.message,
        })),
      },
    })
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
    if (options.hooks && !shouldReloadDiscoveredHooks) {
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
        logger.error("config_reload", "Hook reload failed; keeping last known good hooks.", {
          cwd: projectDir,
          details: {
            signature: nextLoaded.signature,
            errors: nextLoaded.errors.map((error) => ({
              filePath: error.filePath,
              path: error.path,
              message: error.message,
            })),
          },
        })
        lastReportedInvalidSignature = nextLoaded.signature
      }
      return hooks
    }

    hooks = nextLoaded.hooks
    logger.info("config_reload", "Hook configuration reloaded.", {
      cwd: projectDir,
      details: {
        signature: nextLoaded.signature,
        eventCount: hooks.size,
        files: Array.from(new Set(Array.from(hooks.values()).flat().map((hook) => hook.source.filePath))),
      },
    })
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
      logger.debug("dispatch_start", "Dispatching pre-tool hooks.", {
        cwd: projectDir,
        event: `tool.before.${eventInput.tool}`,
        sessionId: sessionID,
        toolName: eventInput.tool,
        details: { callID: eventInput.callID, toolArgs },
      })

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
        logger.warn("dispatch_end", "Pre-tool dispatch blocked the tool call.", {
          cwd: projectDir,
          event: `tool.before.${eventInput.tool}`,
          sessionId: sessionID,
          toolName: eventInput.tool,
          details: { callID: eventInput.callID, blockReason: result.blockReason, stopSession: result.stopSession === true },
        })
        if (result.stopSession) {
          await abortSession(host, sessionID)
        }
        throw new Error(result.blockReason ?? "Blocked by hook")
      }

      logger.debug("dispatch_end", "Finished pre-tool dispatch.", {
        cwd: projectDir,
        event: `tool.before.${eventInput.tool}`,
        sessionId: sessionID,
        toolName: eventInput.tool,
        details: { callID: eventInput.callID },
      })
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

      logger.debug("dispatch_start", "Dispatching post-tool hooks.", {
        cwd: projectDir,
        event: `tool.after.${eventInput.tool}`,
        sessionId: sessionID,
        toolName: eventInput.tool,
        details: { callID: eventInput.callID, toolArgs, files, changes: summarizeChanges(changes) },
      })

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

      logger.debug("dispatch_end", "Finished post-tool dispatch.", {
        cwd: projectDir,
        event: `tool.after.${eventInput.tool}`,
        sessionId: sessionID,
        toolName: eventInput.tool,
        details: { callID: eventInput.callID, files, changes: summarizeChanges(changes) },
      })
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
        logger.debug("dispatch_start", "Dispatching session.created hooks.", {
          cwd: projectDir,
          event: "session.created",
          sessionId: sessionID,
          details: { parentID: pickString(info?.parentID) ?? null },
        })
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
        logger.debug("dispatch_start", "Dispatching session.deleted hooks.", {
          cwd: projectDir,
          event: "session.deleted",
          sessionId: sessionID,
        })
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
        logger.debug("idle_changes_snapshot", "Captured pending idle changes.", {
          cwd: projectDir,
          event: "session.idle",
          sessionId: sessionID,
          details: { files, changes: summarizeChanges(changes) },
        })
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
          logger.debug("idle_changes_consumed", "Consumed idle changes after dispatch.", {
            cwd: projectDir,
            event: "session.idle",
            sessionId: sessionID,
            details: { files, changes: summarizeChanges(changes) },
          })
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

  const mutationNames = getMutationToolHookNames(toolName);
  const resolvedNames = mutationNames.length > 0 ? mutationNames : [toolName];
  for (const resolvedToolName of resolvedNames) {
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
    getPiHooksLogger().debug("dispatch_skip", "No hooks registered for event.", {
      cwd: projectDir,
      event,
      sessionId: sessionID,
      details: { files: context.files, changes: summarizeChanges(context.changes ?? []) },
    })
    return { blocked: false }
  }

  getPiHooksLogger().debug("dispatch_event", "Dispatching hooks for event.", {
    cwd: projectDir,
    event,
    sessionId: sessionID,
    details: { hookCount: eventHooks.length, files: context.files, changes: summarizeChanges(context.changes ?? []) },
  })

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
    // P2 #23 fix: previously the canBlock branch deferred drain via
    // setTimeout(..., 0) and returned synchronously. That created a window
    // where a fresh dispatch with the same key could race with the deferred
    // drain's `dispatchStates.delete(dispatchKey)`. Always await inline so
    // dispatch state lifetime is well-defined.
    await drainPendingRequests()
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
  const logger = getPiHooksLogger()
  const hookId = getHookIdentifier(hook)
  let decision: HookMatchDecision

  logger.debug("hook_consider", "Evaluating hook against event context.", {
    cwd: projectDir,
    event: hook.event,
    sessionId: sessionID,
    hookId,
    hookSource: formatHookSource(hook),
    details: {
      scope: hook.scope,
      runIn: hook.runIn,
      async: hook.async === true,
      files: context.files,
      changes: summarizeChanges(context.changes ?? []),
      toolName: context.toolName,
    },
  })

  try {
    decision = await shouldRunHook(hook, state, host, projectDir, sessionID, context)
  } catch (error) {
    logger.error("hook_skip", "Hook evaluation failed.", {
      cwd: projectDir,
      event: hook.event,
      sessionId: sessionID,
      hookId,
      hookSource: formatHookSource(hook),
      details: { error: error instanceof Error ? error.message : String(error) },
    })
    logHookFailure(hook.event, hook.source.filePath, error)
    return { blocked: false }
  }

  if (!decision.matched) {
    logger.debug("hook_skip", "Hook did not match the current event context.", {
      cwd: projectDir,
      event: hook.event,
      sessionId: sessionID,
      hookId,
      hookSource: formatHookSource(hook),
      details: {
        reason: decision.reason,
        changedPaths: decision.changedPaths,
        ...decision.details,
      },
    })
    return { blocked: false }
  }

  logger.info("hook_match", "Hook matched the current event context.", {
    cwd: projectDir,
    event: hook.event,
    sessionId: sessionID,
    hookId,
    hookSource: formatHookSource(hook),
    details: {
      changedPaths: decision.changedPaths,
      files: context.files,
      changes: summarizeChanges(context.changes ?? []),
      toolName: context.toolName,
    },
  })

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
            hookId,
            actionRecursionGuards,
          )
        }
      })
      .catch((error) => {
        logger.error("hook_async", "Async hook execution failed.", {
          cwd: projectDir,
          event: hook.event,
          sessionId: sessionID,
          hookId,
          hookSource: formatHookSource(hook),
          details: { error: error instanceof Error ? error.message : String(error) },
        })
        logHookFailure(hook.event, hook.source.filePath, error)
      })
      .finally(() => {
        if (asyncQueues.get(queueKey) === next) {
          asyncQueues.delete(queueKey)
        }
      })
    asyncQueues.set(queueKey, next)
    logger.debug("hook_async", "Queued hook for asynchronous execution.", {
      cwd: projectDir,
      event: hook.event,
      sessionId: sessionID,
      hookId,
      hookSource: formatHookSource(hook),
      details: { queueKey },
    })
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
      hookId,
      actionRecursionGuards,
    )
    if (result.blocked && options.canBlock) {
      logger.warn("hook_block", "Hook action blocked event execution.", {
        cwd: projectDir,
        event: hook.event,
        sessionId: sessionID,
        hookId,
        hookSource: formatHookSource(hook),
        details: { blockReason: result.blockReason, stopSession: hook.action === "stop" },
      })
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
): Promise<HookMatchDecision> {
  const changedPaths = getFinalChangedPaths(projectDir, context)

  if (!(await state.evaluateScope(sessionID, hook.scope, (currentSessionID) => resolveParentSessionID(host, currentSessionID)))) {
    return {
      matched: false,
      reason: "scope_mismatch",
      changedPaths,
      details: { scope: hook.scope },
    }
  }

  for (const condition of hook.conditions ?? []) {
    if (condition === "matchesCodeFiles") {
      const files = context.files ?? []
      if (!files.some(hasCodeExtension)) {
        return {
          matched: false,
          reason: "matchesCodeFiles_failed",
          changedPaths,
          details: { files },
        }
      }

      continue
    }

    if ("matchesAnyPath" in condition) {
      if (changedPaths.length === 0) {
        return {
          matched: false,
          reason: "matchesAnyPath_no_paths",
          changedPaths,
          details: { patterns: condition.matchesAnyPath },
        }
      }

      if (!changedPaths.some((filePath) => condition.matchesAnyPath.some((pattern) => matchesGlob(filePath, pattern)))) {
        return {
          matched: false,
          reason: "matchesAnyPath_failed",
          changedPaths,
          details: { patterns: condition.matchesAnyPath },
        }
      }

      continue
    }

    if (changedPaths.length === 0) {
      return {
        matched: false,
        reason: "matchesAllPaths_no_paths",
        changedPaths,
        details: { patterns: condition.matchesAllPaths },
      }
    }

    if (!changedPaths.every((filePath) => condition.matchesAllPaths.some((pattern) => matchesGlob(filePath, pattern)))) {
      return {
        matched: false,
        reason: "matchesAllPaths_failed",
        changedPaths,
        details: { patterns: condition.matchesAllPaths },
      }
    }
  }

  return { matched: true, reason: "matched", changedPaths }
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
  hookId: string,
  actionRecursionGuards: AsyncLocalStorage<Set<string>>,
): Promise<HookExecutionResult> {
  const logger = getPiHooksLogger()
  const executionDirectory = projectDir
  const actionType = getActionType(action)

  logger.debug("action_start", "Starting hook action.", {
    cwd: projectDir,
    event,
    sessionId: sessionID,
    hookId,
    hookSource: sourceFilePath,
    action: actionType,
    details: getActionDetails(action),
  })

  if ("command" in action) {
    const error = new Error("command: actions are not supported on PI — remove this action or use bash instead")
    logger.error("action_result", "Unsupported command action encountered.", {
      cwd: projectDir,
      event,
      sessionId: sessionID,
      hookId,
      hookSource: sourceFilePath,
      action: actionType,
      details: { error: error.message },
    })
    logHookFailure(event, sourceFilePath, error)
    return { blocked: false }
  }

  if ("tool" in action) {
    try {
      const targetSessionID = await resolveActionSessionID(state, host, sessionID, runIn)
      if (!targetSessionID) {
        logger.warn("action_result", "Tool action skipped because target session is unavailable.", {
          cwd: projectDir,
          event,
          sessionId: sessionID,
          hookId,
          hookSource: sourceFilePath,
          action: actionType,
        })
        return { blocked: false }
      }

      const prompt = `Use the ${action.tool.name} tool with these arguments: ${JSON.stringify(action.tool.args ?? {})}`
      const actionKey = `${event}:${targetSessionID}:tool:${sourceFilePath}:${JSON.stringify(action.tool)}`
      let delivery: HostDeliveryResult = { status: "accepted" }
      await withActionRecursionGuard(actionRecursionGuards, actionKey, async () => {
        delivery = normalizeHostDeliveryResult(await host.sendPrompt(targetSessionID, prompt))
      })
      const deliveryDetails = {
        targetSessionID,
        prompt,
        args: action.tool.args ?? {},
        ...(delivery.reason ? { reason: delivery.reason } : {}),
        ...(delivery.details ? delivery.details : {}),
      }
      if (delivery.status === "degraded") {
        logger.warn("action_result", "Tool action degraded before the follow-up prompt was accepted.", {
          cwd: projectDir,
          event,
          sessionId: sessionID,
          hookId,
          hookSource: sourceFilePath,
          action: actionType,
          toolName: action.tool.name,
          details: deliveryDetails,
        })
      } else {
        logger.info("action_result", "Tool action queued a follow-up prompt.", {
          cwd: projectDir,
          event,
          sessionId: sessionID,
          hookId,
          hookSource: sourceFilePath,
          action: actionType,
          toolName: action.tool.name,
          details: deliveryDetails,
        })
      }
    } catch (error) {
      logger.error("action_result", "Tool action failed.", {
        cwd: projectDir,
        event,
        sessionId: sessionID,
        hookId,
        hookSource: sourceFilePath,
        action: actionType,
        details: { error: error instanceof Error ? error.message : String(error) },
      })
      logHookFailure(event, sourceFilePath, error)
    }

    return { blocked: false }
  }

  if ("notify" in action) {
    try {
      const config = typeof action.notify === "string" ? { text: action.notify } : action.notify
      const level = config.level ?? "info"
      if (typeof host.notify === "function") {
        const delivery = normalizeHostDeliveryResult(await host.notify(config.text, level))
        const deliveryDetails = {
          text: config.text,
          level,
          ...(delivery.reason ? { reason: delivery.reason } : {}),
          ...(delivery.details ? delivery.details : {}),
        }
        if (delivery.status === "degraded") {
          logger.warn("action_result", "Notification action degraded before the host accepted it.", {
            cwd: projectDir,
            event,
            sessionId: sessionID,
            hookId,
            hookSource: sourceFilePath,
            action: actionType,
            details: deliveryDetails,
          })
        } else {
          logger.info("action_result", "Notification action delivered.", {
            cwd: projectDir,
            event,
            sessionId: sessionID,
            hookId,
            hookSource: sourceFilePath,
            action: actionType,
            details: deliveryDetails,
          })
        }
      } else {
        console.warn(`[pi-hooks] notify action skipped (host.notify not implemented): ${config.text}`)
        logger.warn("action_result", "Notification action skipped because host.notify is unavailable.", {
          cwd: projectDir,
          event,
          sessionId: sessionID,
          hookId,
          hookSource: sourceFilePath,
          action: actionType,
          details: { text: config.text, level },
        })
      }
    } catch (error) {
      logger.error("action_result", "Notification action failed.", {
        cwd: projectDir,
        event,
        sessionId: sessionID,
        hookId,
        hookSource: sourceFilePath,
        action: actionType,
        details: { error: error instanceof Error ? error.message : String(error) },
      })
      logHookFailure(event, sourceFilePath, error)
    }
    return { blocked: false }
  }

  if ("confirm" in action) {
    try {
      if (typeof host.confirm === "function") {
        const approved = await host.confirm({
          ...(action.confirm.title !== undefined ? { title: action.confirm.title } : {}),
          message: action.confirm.message,
        })
        logger.info("action_result", "Confirmation action completed.", {
          cwd: projectDir,
          event,
          sessionId: sessionID,
          hookId,
          hookSource: sourceFilePath,
          action: actionType,
          details: { title: action.confirm.title, message: action.confirm.message, approved },
        })
        if (!approved) {
          return { blocked: true, blockReason: "Blocked by user via confirm action" }
        }
      } else {
        console.warn(`[pi-hooks] confirm action skipped (host.confirm not implemented): ${action.confirm.message}`)
        logger.warn("action_result", "Confirmation action skipped because host.confirm is unavailable.", {
          cwd: projectDir,
          event,
          sessionId: sessionID,
          hookId,
          hookSource: sourceFilePath,
          action: actionType,
          details: { title: action.confirm.title, message: action.confirm.message },
        })
      }
    } catch (error) {
      logger.error("action_result", "Confirmation action failed.", {
        cwd: projectDir,
        event,
        sessionId: sessionID,
        hookId,
        hookSource: sourceFilePath,
        action: actionType,
        details: { error: error instanceof Error ? error.message : String(error) },
      })
      logHookFailure(event, sourceFilePath, error)
    }
    return { blocked: false }
  }

  if ("setStatus" in action) {
    try {
      const config = typeof action.setStatus === "string" ? { text: action.setStatus } : action.setStatus
      if (typeof host.setStatus === "function") {
        const statusHookId = `${sourceFilePath}#${event}`
        const delivery = normalizeHostDeliveryResult(await host.setStatus(statusHookId, config.text))
        const deliveryDetails = {
          statusHookId,
          text: config.text,
          ...(delivery.reason ? { reason: delivery.reason } : {}),
          ...(delivery.details ? delivery.details : {}),
        }
        if (delivery.status === "degraded") {
          logger.warn("action_result", "Status action degraded before the host accepted it.", {
            cwd: projectDir,
            event,
            sessionId: sessionID,
            hookId,
            hookSource: sourceFilePath,
            action: actionType,
            details: deliveryDetails,
          })
        } else {
          logger.info("action_result", "Status action updated the PI status surface.", {
            cwd: projectDir,
            event,
            sessionId: sessionID,
            hookId,
            hookSource: sourceFilePath,
            action: actionType,
            details: deliveryDetails,
          })
        }
      } else {
        console.warn(`[pi-hooks] setStatus action skipped (host.setStatus not implemented): ${config.text}`)
        logger.warn("action_result", "Status action skipped because host.setStatus is unavailable.", {
          cwd: projectDir,
          event,
          sessionId: sessionID,
          hookId,
          hookSource: sourceFilePath,
          action: actionType,
          details: { text: config.text },
        })
      }
    } catch (error) {
      logger.error("action_result", "Status action failed.", {
        cwd: projectDir,
        event,
        sessionId: sessionID,
        hookId,
        hookSource: sourceFilePath,
        action: actionType,
        details: { error: error instanceof Error ? error.message : String(error) },
      })
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

  logger.info("action_result", "Bash action completed.", {
    cwd: projectDir,
    event,
    sessionId: sessionID,
    hookId,
    hookSource: sourceFilePath,
    action: actionType,
    details: {
      command: config.command,
      timeout: config.timeout,
      status: result.status,
      exitCode: result.exitCode,
      blocking: result.blocking,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
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

function getHookIdentifier(hook: HookConfig): string {
  return hook.id ?? `${hook.source.filePath}#hooks[${hook.source.index}]`
}

function formatHookSource(hook: HookConfig): string {
  return `${hook.source.filePath}#hooks[${hook.source.index}]`
}

function getActionType(action: HookAction): string {
  if ("command" in action) return "command"
  if ("tool" in action) return "tool"
  if ("bash" in action) return "bash"
  if ("notify" in action) return "notify"
  if ("confirm" in action) return "confirm"
  return "setStatus"
}

function getActionDetails(action: HookAction): Record<string, unknown> {
  if ("command" in action) {
    return { command: action.command }
  }

  if ("tool" in action) {
    return { name: action.tool.name, args: action.tool.args ?? {} }
  }

  if ("bash" in action) {
    const config = typeof action.bash === "string" ? { command: action.bash } : action.bash
    return { command: config.command, timeout: config.timeout }
  }

  if ("notify" in action) {
    const config = typeof action.notify === "string" ? { text: action.notify } : action.notify
    return { text: config.text, level: config.level ?? "info" }
  }

  if ("confirm" in action) {
    return { title: action.confirm.title, message: action.confirm.message }
  }

  const config = typeof action.setStatus === "string" ? { text: action.setStatus } : action.setStatus
  return { text: config.text }
}

function summarizeChanges(changes: readonly FileChange[]): Array<Record<string, unknown>> {
  return changes.map((change) =>
    change.operation === "rename"
      ? { operation: change.operation, fromPath: change.fromPath, toPath: change.toPath }
      : { operation: change.operation, path: change.path },
  )
}

function logHookFailure(event: HookEvent, filePath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  getPiHooksLogger().error("hook_error", "Hook execution failed.", {
    event,
    hookSource: filePath,
    details: { error: message },
  })
  console.error(`[pi-hooks] ${event} hook from ${filePath} failed: ${message}`)
}

function normalizeHostDeliveryResult(result: void | HostDeliveryResult | undefined): HostDeliveryResult {
  if (
    result &&
    typeof result === "object" &&
    (result.status === "accepted" || result.status === "degraded")
  ) {
    return result
  }

  return { status: "accepted" }
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

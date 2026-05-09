import { AsyncLocalStorage } from "node:async_hooks"
import { statSync } from "node:fs"

import { executeBashHook } from "./bash-executor.js"
import type { BashExecutionRequest, BashHookResult } from "./bash-types.js"
import { discoverHookConfigEntries } from "./config-paths.js"
import { loadDiscoveredHooksSnapshot } from "./load-hooks.js"
import { getPiHooksLogger } from "./logger.js"
import {
  buildPathMatchContext,
  createGlobMatcherCache,
  defaultGlobMatcher,
  evaluatePathConditions,
  getGlobMatcher,
  type GlobMatcher,
  type GlobMatcherCache,
} from "./runtime/path-filter.js"
import {
  executeAction,
  logHookFailure,
  resolveParentSessionID,
} from "./runtime/actions.js"
import {
  enqueueAsyncHook,
  resolveAsyncExecutionConfig,
  type AsyncQueueState,
} from "./runtime/async-queue.js"
import { withActionRecursionGuard } from "./runtime/recursion-guard.js"
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

export { buildPathMatchContext } from "./runtime/path-filter.js"

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

export interface RuntimeActionContext {
  readonly files?: readonly string[]
  readonly changes?: readonly FileChange[]
  readonly toolName?: string
  readonly toolArgs?: Record<string, unknown>
  readonly sourceSessionID?: string
  readonly targetSessionID?: string
  readonly pathMatchContext?: PathMatchContext
}

export interface PathMatchContext {
  readonly changedPaths: readonly string[]
  readonly hasCodeFiles: boolean
}

export interface HookExecutionResult {
  readonly blocked: boolean
  readonly blockReason?: string
  readonly stopSession?: boolean
}

export interface HookMatchDecision {
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
  // P1-13 fix: capture the AsyncLocalStorage store at park time so the
  // queued execution re-enters the *enqueueing* dispatch's recursion-guard
  // frame on drain. Without this, drained requests run under whatever the
  // initial-dispatch's frame happens to be (often a fresh, empty Set), and
  // the per-action dedup keys leak across unrelated dispatch chains.
  readonly recursionGuardStore?: Set<string>
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
  readonly "user.bash.before": (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) => Promise<void>
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
  // P1-1 fix: stat-only fingerprint computed from the most recently loaded
  // file set so refreshHooks can short-circuit without re-entering the
  // (heavier) load-hooks parsing path on every event. The fingerprint covers
  // the discovered roots PLUS any imports that the previous load resolved,
  // so editing an imported file still busts the cache. The first refresh
  // after construction uses the file set captured by the initial discovery
  // call above (or, for `options.hooks`, an empty set so the gate below
  // continues to short-circuit).
  let lastLoadedFiles: readonly string[] = options.hooks
    ? []
    : (loaded as { files?: readonly string[] }).files ?? []
  let lastStatFingerprint = computeStatFingerprint(lastLoadedFiles)
  const state = new SessionStateStore()
  const runBashHook: ExecuteBashHook = options.executeBash ?? ((request) => host.runBash(request))
  const dispatchStates = new Map<string, DispatchState>()
  const asyncQueues = new Map<string, AsyncQueueState>()
  const actionRecursionGuards = new AsyncLocalStorage<Set<string>>()
  // P2-5 fix: per-runtime glob matcher cache. Rebuilt on hooks reload so a
  // changed pattern set does not retain stale match closures or stale
  // (path → boolean) entries.
  let globMatcherCache: GlobMatcherCache = createGlobMatcherCache(lastLoadedSignature)
  const boundGlobMatcher: GlobMatcher = (filePath, pattern) =>
    getGlobMatcher(globMatcherCache, pattern)(filePath)

  function refreshHooks(): HookMap {
    if (options.hooks && !shouldReloadDiscoveredHooks) {
      return hooks
    }

    // P1-1 fix: compute a cheap stat fingerprint over the previously loaded
    // file set plus the currently discovered roots. If nothing has changed
    // we skip the YAML parse + import expansion entirely. Discovered roots
    // are included so a newly added (or removed) hooks.yaml still triggers
    // a real reload — `statSync` returns "missing" for absent paths, which
    // changes the fingerprint as expected.
    const discoveredEntries = discoverHookConfigEntries({ projectDir })
    const discoveredFiles = discoveredEntries.map((entry) => entry.filePath)
    const fingerprintFiles = mergeUnique(lastLoadedFiles, discoveredFiles)
    const nextStatFingerprint = computeStatFingerprint(fingerprintFiles)
    if (nextStatFingerprint === lastStatFingerprint && lastLoadedFiles.length > 0) {
      return hooks
    }

    const nextLoaded = loadDiscoveredHooksSnapshot({ projectDir })
    lastLoadedFiles = nextLoaded.files
    lastStatFingerprint = computeStatFingerprint(mergeUnique(nextLoaded.files, discoveredFiles))
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
    // P2-5 fix: rebuild the glob-matcher cache on every successful reload
    // so newly added/removed conditions do not reuse stale match closures
    // and so the per-pattern result cache is dropped along with the old
    // hook set.
    globMatcherCache = createGlobMatcherCache(nextLoaded.signature)
    // P3 #23: prefer the precomputed loaded.files list over re-flattening the
    // hook map on every reload. The two are equivalent (both are the unique
    // file paths a hook came from), but `loaded.files` is built once during
    // discovery and avoids an O(hooks) flatten + dedupe on the hot path.
    logger.info("config_reload", "Hook configuration reloaded.", {
      cwd: projectDir,
      details: {
        signature: nextLoaded.signature,
        eventCount: hooks.size,
        files: nextLoaded.files,
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
        boundGlobMatcher,
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
          boundGlobMatcher,
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
        boundGlobMatcher,
      )

      logger.debug("dispatch_end", "Finished post-tool dispatch.", {
        cwd: projectDir,
        event: `tool.after.${eventInput.tool}`,
        sessionId: sessionID,
        toolName: eventInput.tool,
        details: { callID: eventInput.callID, files, changes: summarizeChanges(changes) },
      })
    },

    "user.bash.before": async (
      eventInput: ToolExecuteBeforeInput,
      eventOutput: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      const activeHooks = refreshHooks()
      const sessionID = eventInput.sessionID
      if (!sessionID) {
        return
      }

      const toolArgs = eventOutput.args ?? {}
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
        boundGlobMatcher,
      )

      if (result.blocked) {
        if (result.stopSession) {
          await abortSession(host, sessionID)
        }
        throw new Error(result.blockReason ?? "Blocked by hook")
      }
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

        // P1-3 fix: when `parentID` is omitted (the PI adapter no longer
        // forwards `header.parentSession`, which was a file path rather than
        // a session ID), seed the SessionRecord without a parentID so the
        // runtime defers lineage resolution to `host.getRootSessionId`. When
        // a host does provide a parentID, honour it as-is.
        const parentID = pickString(info?.parentID)
        state.rememberSession(sessionID, parentID === undefined ? undefined : parentID)
        logger.debug("dispatch_start", "Dispatching session.created hooks.", {
          cwd: projectDir,
          event: "session.created",
          sessionId: sessionID,
          details: { parentID: parentID ?? null },
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
          boundGlobMatcher,
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
        // P1-4 fix: surface the `reason` PI emits on session_shutdown /
        // session_before_switch (e.g. "quit", "reload", "new", "resume",
        // "fork") in dispatch telemetry so operators can tell graceful
        // shutdowns apart from /new|/resume|/fork transitions. The reason
        // travels with the envelope but is otherwise advisory; hook
        // matching is unaffected.
        const deletedReason = pickString(properties.reason)
        logger.debug("dispatch_start", "Dispatching session.deleted hooks.", {
          cwd: projectDir,
          event: "session.deleted",
          sessionId: sessionID,
          ...(deletedReason ? { details: { reason: deletedReason } } : {}),
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
          boundGlobMatcher,
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
            boundGlobMatcher,
          )
          state.consumeFileChanges(sessionID, changes)
          logger.debug("idle_changes_consumed", "Consumed idle changes after dispatch.", {
            cwd: projectDir,
            event: "session.idle",
            sessionId: sessionID,
            details: { files, changes: summarizeChanges(changes) },
          })
        } catch (error) {
          // P2-10 fix: distinguish a hook-returned-failure (the dispatch
          // ran, a hook threw and was logged elsewhere) from a host-died
          // failure (the embedding host went down mid-dispatch). The
          // former is bounded — re-dispatching the same idle changes will
          // just re-throw the same error and pin the session. The latter
          // is transient — the operator will restart and we want the
          // pending changes intact when the next idle fires. Heuristic:
          // host errors usually surface as connection/abort/EPIPE-style
          // messages, while in-process hook failures bubble up generic
          // Error instances (or are already swallowed by executeHook's
          // try/catch). On host-died, keep the changes for replay; on a
          // hook failure, consume so the session does not loop.
          if (isHostDiedError(error)) {
            state.cancelIdleDispatch(sessionID)
            logger.warn("idle_dispatch_host_died", "Idle dispatch failed because the host appears to have died; pending changes retained for replay.", {
              cwd: projectDir,
              event: "session.idle",
              sessionId: sessionID,
              details: {
                files,
                changes: summarizeChanges(changes),
                error: error instanceof Error ? error.message : String(error),
              },
            })
            throw error
          }

          state.consumeFileChanges(sessionID, changes)
          logger.error("idle_dispatch_failed", "Idle dispatch failed; consumed pending changes to avoid a re-dispatch loop.", {
            cwd: projectDir,
            event: "session.idle",
            sessionId: sessionID,
            details: {
              files,
              changes: summarizeChanges(changes),
              error: error instanceof Error ? error.message : String(error),
            },
          })
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
  asyncQueues: Map<string, AsyncQueueState>,
  phase: "before" | "after",
  toolName: string,
  sessionID: string,
  context: RuntimeActionContext,
  globMatcher: GlobMatcher = defaultGlobMatcher,
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
    globMatcher,
  )
  if (wildcardResult.blocked) {
    return wildcardResult
  }

  // P1-14 fix: when a tool has multiple alias names (e.g. apply_patch resolves
  // to ["patch", "apply_patch"]), dispatching against each alias key fires
  // every hook bucket independently. A hook registered under `tool.after.patch`
  // and another under `tool.after.apply_patch` would both run for a single
  // apply_patch call even though they describe the same logical event.
  // Dedupe HookConfig instances across alias buckets by reference identity
  // and dispatch the union once under the canonical alias name (the last
  // entry in `resolvedNames`, which is the normalized form returned by
  // `normalizeMutationToolName`). Single-alias tools keep the original
  // single-pass behaviour.
  const mutationNames = getMutationToolHookNames(toolName);
  const resolvedNames = mutationNames.length > 0 ? mutationNames : [toolName];
  if (resolvedNames.length > 1) {
    const unionedHooks = collectUniqueHooksAcrossAliases(hooks, phase, resolvedNames)
    if (unionedHooks.length === 0) {
      return { blocked: false }
    }
    const canonicalEvent = `tool.${phase}.${resolvedNames[resolvedNames.length - 1]}` as HookEvent
    const aliasMap: HookMap = new Map()
    aliasMap.set(canonicalEvent, unionedHooks)
    return await dispatchHooks(
      aliasMap,
      state,
      host,
      projectDir,
      runBashHook,
      canonicalEvent,
      sessionID,
      context,
      { canBlock: phase === "before" },
      dispatchStates,
      actionRecursionGuards,
      asyncQueues,
      globMatcher,
    )
  }

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
      globMatcher,
    )

    if (result.blocked) {
      return result
    }
  }

  return { blocked: false }
}

function collectUniqueHooksAcrossAliases(
  hooks: HookMap,
  phase: "before" | "after",
  aliasNames: readonly string[],
): HookConfig[] {
  const seen = new Set<HookConfig>()
  const out: HookConfig[] = []
  for (const aliasName of aliasNames) {
    const eventKey = `tool.${phase}.${aliasName}` as HookEvent
    const bucket = hooks.get(eventKey)
    if (!bucket) continue
    for (const hook of bucket) {
      if (seen.has(hook)) continue
      seen.add(hook)
      out.push(hook)
    }
  }
  return out
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
  asyncQueues: Map<string, AsyncQueueState>,
  globMatcher: GlobMatcher = defaultGlobMatcher,
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
    // P1-13 fix: snapshot the ALS recursion-guard store *now* so the queued
    // dispatch re-enters the same frame on drain. `getStore()` returns the
    // current Set if we are inside a withActionRecursionGuard run, or
    // `undefined` if no guard is active — both cases are safe to capture.
    const recursionGuardStore = actionRecursionGuards.getStore()
    if (!options.canBlock) {
      dispatchState.pending.push({ context, options, ...(recursionGuardStore ? { recursionGuardStore } : {}) })
      return { blocked: false }
    }

    return await new Promise<HookExecutionResult>((resolve, reject) => {
      dispatchState.pending.push({
        context,
        options,
        resolve,
        reject,
        ...(recursionGuardStore ? { recursionGuardStore } : {}),
      })
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
        prepareRuntimeActionContext(projectDir, request.context),
        request.options,
        actionRecursionGuards,
        asyncQueues,
        globMatcher,
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
          // P1-13 fix: re-enter the recursion-guard frame that was active
          // when this request was parked. Without this, queued dispatches
          // resume under an empty Set (or whatever the *current* frame
          // happens to be) and the recursion guard either misses real
          // re-entries or falsely dedupes unrelated ones.
          const result = request.recursionGuardStore
            ? await actionRecursionGuards.run(request.recursionGuardStore, () => executeDispatchRequest(request))
            : await executeDispatchRequest(request)
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
  asyncQueues: Map<string, AsyncQueueState>,
  globMatcher: GlobMatcher = defaultGlobMatcher,
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
    decision = await shouldRunHook(hook, state, host, projectDir, sessionID, context, globMatcher)
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
    // P1-15 runtime guard: async hooks cannot enforce `action: stop` because
    // the dispatch loop has already returned by the time the queued action
    // runs. The proper rejection belongs in load-hooks parseHookAction
    // (lane: core-loader); we surface a one-shot warning here so operators
    // notice the silent no-op without spamming on every dispatch.
    if (hook.action === "stop") {
      warnAsyncStopOnce(logger, hook, projectDir)
    }
    const asyncConfig = resolveAsyncExecutionConfig(hook, sessionID)
    enqueueAsyncHook(
      asyncQueues,
      asyncConfig,
      async () => {
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
      },
      (error) => {
        logger.error("hook_async", "Async hook execution failed.", {
          cwd: projectDir,
          event: hook.event,
          sessionId: sessionID,
          hookId,
          hookSource: formatHookSource(hook),
          details: { error: error instanceof Error ? error.message : String(error) },
        })
        logHookFailure(hook.event, hook.source.filePath, error)
      },
    )
    logger.debug("hook_async", "Queued hook for asynchronous execution.", {
      cwd: projectDir,
      event: hook.event,
      sessionId: sessionID,
      hookId,
      hookSource: formatHookSource(hook),
      details: { queueKey: asyncConfig.queueKey, concurrency: asyncConfig.concurrency },
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
  globMatcher: GlobMatcher,
): Promise<HookMatchDecision> {
  const pathMatchContext = context.pathMatchContext ?? buildPathMatchContext(projectDir, context)
  const changedPaths = pathMatchContext.changedPaths

  if (!(await state.evaluateScope(sessionID, hook.scope, (currentSessionID) => resolveParentSessionID(host, currentSessionID)))) {
    return {
      matched: false,
      reason: "scope_mismatch",
      changedPaths,
      details: { scope: hook.scope },
    }
  }

  const conditionFailure = evaluatePathConditions(hook, context, pathMatchContext, globMatcher)
  if (conditionFailure) {
    return conditionFailure
  }

  return { matched: true, reason: "matched", changedPaths }
}

function prepareRuntimeActionContext(projectDir: string, context: RuntimeActionContext): RuntimeActionContext {
  if (context.pathMatchContext) {
    return context
  }

  return {
    ...context,
    pathMatchContext: buildPathMatchContext(projectDir, context),
  }
}


// P2-10 helper: classify a thrown idle-dispatch error as transient
// (host-died-style) vs. terminal (hook-no). Host-died errors are kept for
// replay; everything else is consumed so a poisonous hook does not pin the
// session in an infinite re-dispatch loop. We match a small set of
// well-known IPC/socket failure shapes plus errors that explicitly tag
// themselves with `code` strings the PI host emits when it goes down.
function isHostDiedError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false
  }
  const code = (error as { code?: unknown }).code
  if (typeof code === "string") {
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "ENOTCONN" ||
      code === "EHOSTDOWN" ||
      code === "ESHUTDOWN" ||
      code === "HOST_DIED" ||
      code === "HOST_DISCONNECTED"
    ) {
      return true
    }
  }
  const message = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? "")
  if (typeof message === "string" && message.length > 0) {
    const lowered = message.toLowerCase()
    return (
      lowered.includes("host died") ||
      lowered.includes("host disconnected") ||
      lowered.includes("connection refused") ||
      lowered.includes("connection reset") ||
      lowered.includes("broken pipe") ||
      lowered.includes("socket hang up") ||
      lowered.includes("not connected")
    )
  }
  return false
}

async function abortSession(host: HostAdapter, sessionID: string): Promise<void> {
  try {
    await host.abort(sessionID)
  } catch (error) {
    // P2-11 fix: route abort failures through the structured logger so
    // operators tailing ~/.pi/agent/log/hooks.log see the failure with
    // sessionID and error context. Previously the raw console.error
    // bypassed the logger entirely, which made tail-hook-log workflows
    // miss aborted-session signals.
    const message = error instanceof Error ? error.message : String(error)
    getPiHooksLogger().error("session_abort_failed", "Failed to abort session.", {
      sessionId: sessionID,
      details: { error: message },
    })
  }
}

// P1-1 helper: cheap stat-based fingerprint shared by the runtime-side
// refreshHooks short-circuit. Returns a stable string that changes whenever
// any of the listed files' mtime/size changes, or whenever a file appears
// or disappears. Mirrors the shape used by load-hooks' own snapshot cache.
function computeStatFingerprint(files: readonly string[]): string {
  if (files.length === 0) {
    return ""
  }
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

function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of a) {
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  for (const value of b) {
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

function formatHookLoadErrors(errors: Array<{ filePath: string; message: string; path?: string }>): string {
  const details = errors.map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
  return `[pi-yaml-hooks] Failed to load some hooks; continuing with valid hooks:\n${details.join("\n")}`
}

function formatHookReloadErrors(errors: Array<{ filePath: string; message: string; path?: string }>): string {
  const details = errors.map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
  return `[pi-yaml-hooks] Failed to reload hooks.yaml; keeping last known good hooks:\n${details.join("\n")}`
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

// P1-15 runtime guard: warn (once per hook source) when a hook combines
// `async: true` with `action: stop`. The async queue runs after the
// dispatch loop has already returned, so `action: stop` is silently
// dropped. Parse-time rejection should land in load-hooks; this warning
// is the runtime safety net.
const warnedAsyncStopHookSources = new Set<string>()

function warnAsyncStopOnce(
  logger: ReturnType<typeof getPiHooksLogger>,
  hook: HookConfig,
  projectDir: string,
): void {
  const sourceKey = formatHookSource(hook)
  if (warnedAsyncStopHookSources.has(sourceKey)) {
    return
  }
  warnedAsyncStopHookSources.add(sourceKey)
  const message = `[pi-yaml-hooks] hook ${sourceKey} declares both async and action: stop; the stop directive is ignored because async hooks cannot block dispatch.`
  // eslint-disable-next-line no-console
  console.warn(message)
  logger.warn("hook_async_stop_ignored", "Async hook combined with action: stop; stop ignored.", {
    cwd: projectDir,
    event: hook.event,
    hookId: getHookIdentifier(hook),
    hookSource: formatHookSource(hook),
  })
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
  console.error(`[pi-yaml-hooks] ${event} hook from ${filePath} failed: ${message}`)
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


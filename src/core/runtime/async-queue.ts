/**
 * Async hook queue extracted from runtime.ts.
 *
 * Hooks declared `async: true` are not part of the dispatch loop —
 * they queue onto a per-(event|group)+session lane that respects the
 * configured concurrency limit. Behaviour preserved verbatim, including
 * the P3-1 simplification (`Promise.resolve().then(next)` over a sync
 * IIFE) for converting synchronous throws into rejected promises.
 */

import type { HookConfig } from "../types.js"

export interface AsyncQueueState {
  activeCount: number
  pending: Array<() => Promise<void>>
}

export function resolveAsyncExecutionConfig(
  hook: HookConfig,
  sessionID: string,
): { queueKey: string; concurrency: number } {
  if (hook.async === true || hook.async === undefined) {
    return { queueKey: `${hook.event}:${sessionID}`, concurrency: 1 }
  }

  const group = hook.async.group?.trim()
  return {
    queueKey: group ? `${sessionID}:${group}` : `${hook.event}:${sessionID}`,
    concurrency: hook.async.concurrency ?? 1,
  }
}

export function enqueueAsyncHook(
  asyncQueues: Map<string, AsyncQueueState>,
  config: { queueKey: string; concurrency: number },
  run: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  const state = asyncQueues.get(config.queueKey) ?? { activeCount: 0, pending: [] }
  asyncQueues.set(config.queueKey, state)

  const startNext = (): void => {
    while (state.activeCount < config.concurrency && state.pending.length > 0) {
      const next = state.pending.shift()
      if (!next) {
        continue
      }

      state.activeCount += 1
      // P2 #13: wrap the call so a synchronous throw from `next()` (e.g.
      // before the function awaits) is converted into a rejected promise.
      // Without this wrapper a sync throw would skip .catch/.finally and
      // leak activeCount, eventually wedging the queue.
      // P3-1 simplification: `Promise.resolve().then(next)` expresses the
      // same semantics with one fewer Promise allocation than the
      // previous `(async () => next())()` IIFE — both convert sync
      // throws to rejections; the `.then` form skips the implicit
      // async-function wrapper promise.
      void Promise.resolve()
        .then(next)
        .catch(onError)
        .finally(() => {
          state.activeCount -= 1
          if (state.activeCount === 0 && state.pending.length === 0) {
            asyncQueues.delete(config.queueKey)
            return
          }
          startNext()
        })
    }
  }

  state.pending.push(run)
  startNext()
}

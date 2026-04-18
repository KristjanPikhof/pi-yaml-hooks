import type { FileChange } from "./types.js"

export interface PendingToolCall {
  readonly sessionID: string
  readonly toolArgs: Record<string, unknown>
}

interface SessionRecord {
  parentID?: string | null
  rootSessionID?: string
  deleted: boolean
  changes: FileChange[]
   changeKeys: Set<string>
   activeIdleDispatchKeys?: Set<string>
   replayedDuringIdleKeys: Set<string>
}

export type SessionScope = "all" | "main" | "child"

export class SessionStateStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly pendingToolCalls = new Map<string, PendingToolCall>()

  rememberSession(sessionID: string, parentID?: string | null): void {
    const record = this.getOrCreateSession(sessionID)
    record.deleted = false

    if (parentID !== undefined) {
      record.parentID = parentID
      record.rootSessionID = parentID ? this.sessions.get(parentID)?.rootSessionID : sessionID
    }
  }

  async evaluateScope(
    sessionID: string,
    scope: SessionScope,
    resolveParentID: (sessionID: string) => Promise<string | null | undefined>,
  ): Promise<boolean> {
    if (scope === "all") {
      return true
    }

    const rootSessionID = await this.getRootSessionID(sessionID, resolveParentID)
    const isMainSession = rootSessionID === sessionID
    return scope === "main" ? isMainSession : !isMainSession
  }

  async getRootSessionID(
    sessionID: string,
    resolveParentID: (sessionID: string) => Promise<string | null | undefined>,
  ): Promise<string> {
    return this.resolveRootSessionID(sessionID, resolveParentID, new Set())
  }

  isDeleted(sessionID: string): boolean {
    return this.sessions.get(sessionID)?.deleted ?? false
  }

  deleteSession(sessionID: string): void {
    const record = this.getOrCreateSession(sessionID)
    record.deleted = true
    record.changes = []
    record.changeKeys.clear()
    record.activeIdleDispatchKeys = undefined
    record.replayedDuringIdleKeys.clear()

    for (const [callID, pending] of this.pendingToolCalls) {
      if (pending.sessionID === sessionID) {
        this.pendingToolCalls.delete(callID)
      }
    }
  }

  setPendingToolCall(callID: string, sessionID: string, toolArgs: Record<string, unknown>): void {
    this.pendingToolCalls.set(callID, { sessionID, toolArgs })
  }

  consumePendingToolCall(callID: string): PendingToolCall | undefined {
    const pending = this.pendingToolCalls.get(callID)
    if (!pending) {
      return undefined
    }

    this.pendingToolCalls.delete(callID)
    return pending
  }

  addFileChanges(sessionID: string, changes: Iterable<FileChange>): void {
    const record = this.getOrCreateSession(sessionID)
    for (const change of changes) {
      const key = serializeFileChange(change)
      if (record.activeIdleDispatchKeys?.has(key)) {
        record.replayedDuringIdleKeys.add(key)
      }

      if (!record.changeKeys.has(key)) {
        record.changeKeys.add(key)
        record.changes.push(change)
      }
    }
  }

  getFileChanges(sessionID: string): FileChange[] {
    const record = this.sessions.get(sessionID)
    if (!record || record.changes.length === 0) {
      return []
    }

    return [...record.changes]
  }

  getModifiedPaths(sessionID: string): string[] {
    return getChangedPaths(this.getFileChanges(sessionID))
  }

  beginIdleDispatch(sessionID: string, changes: readonly FileChange[]): void {
    const record = this.getOrCreateSession(sessionID)
    record.activeIdleDispatchKeys = new Set(changes.map((change) => serializeFileChange(change)))
    record.replayedDuringIdleKeys.clear()
  }

  consumeFileChanges(sessionID: string, changes: readonly FileChange[]): void {
    const record = this.sessions.get(sessionID)
    if (!record) {
      return
    }

    const replayedChanges = new Map<string, FileChange>()

    for (const change of changes) {
      const key = serializeFileChange(change)
      record.changeKeys.delete(key)

      if (record.replayedDuringIdleKeys.has(key)) {
        replayedChanges.set(key, change)
      }
    }

    record.changes = record.changes.filter((change) => record.changeKeys.has(serializeFileChange(change)))

    for (const [key, change] of replayedChanges) {
      if (!record.changeKeys.has(key)) {
        record.changeKeys.add(key)
        record.changes.push(change)
      }
    }

    record.activeIdleDispatchKeys = undefined
    record.replayedDuringIdleKeys.clear()
  }

  cancelIdleDispatch(sessionID: string): void {
    const record = this.sessions.get(sessionID)
    if (!record) {
      return
    }

    record.activeIdleDispatchKeys = undefined
    record.replayedDuringIdleKeys.clear()
  }

  private getOrCreateSession(sessionID: string): SessionRecord {
    let record = this.sessions.get(sessionID)
    if (!record) {
      record = { deleted: false, changes: [], changeKeys: new Set(), replayedDuringIdleKeys: new Set() }
      this.sessions.set(sessionID, record)
    }
    return record
  }

  private async resolveRootSessionID(
    sessionID: string,
    resolveParentID: (sessionID: string) => Promise<string | null | undefined>,
    visited: Set<string>,
  ): Promise<string> {
    const record = this.getOrCreateSession(sessionID)
    if (visited.has(sessionID)) {
      record.rootSessionID = sessionID
      return sessionID
    }

    visited.add(sessionID)

    let parentID = record.parentID
    if (parentID === undefined) {
      parentID = (await resolveParentID(sessionID)) ?? null
      record.parentID = parentID
    }

    if (!parentID) {
      record.rootSessionID = sessionID
      return sessionID
    }

    if (record.rootSessionID) {
      const parentRootSessionID = this.sessions.get(parentID)?.rootSessionID
      if (parentRootSessionID && parentRootSessionID === record.rootSessionID) {
        return record.rootSessionID
      }
    }

    const rootSessionID = await this.resolveRootSessionID(parentID, resolveParentID, visited)
    record.rootSessionID = rootSessionID
    return rootSessionID
  }
}

function getChangedPaths(changes: readonly FileChange[]): string[] {
  const paths = new Set<string>()

  for (const change of changes) {
    if (change.operation === "rename") {
      if (change.fromPath) {
        paths.add(change.fromPath)
      }
      if (change.toPath) {
        paths.add(change.toPath)
      }
      continue
    }

    if (change.path) {
      paths.add(change.path)
    }
  }

  return Array.from(paths)
}

function serializeFileChange(change: FileChange): string {
  if (change.operation === "rename") {
    return `${change.operation}:${change.fromPath}->${change.toPath}`
  }

  return `${change.operation}:${change.path}`
}

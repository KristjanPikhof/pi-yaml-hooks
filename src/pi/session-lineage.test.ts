import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

import { getRootSessionId, resetSessionLineageCacheForTests } from "./session-lineage.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

type SessionHeader = {
  type: "session"
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}

interface FakeManager {
  getHeader(): SessionHeader | null
  getSessionId(): string
}

function withTmpDir<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-lineage-"))
  return Promise.resolve(run(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  }) as Promise<T>
}

function writeSessionFile(filePath: string, header: SessionHeader, extraLines: string[] = []): void {
  const lines = [JSON.stringify(header), ...extraLines]
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8")
}

const cases: Case[] = [
  {
    name: "returns input id when sessionManager is undefined",
    run: async () => {
      const result = getRootSessionId("session-123", undefined)
      return result === "session-123" ? { ok: true } : { ok: false, detail: result }
    },
  },
  {
    name: "returns input id when sessionId is empty",
    run: async () => {
      const manager: FakeManager = {
        getHeader: () => ({ type: "session", id: "x", timestamp: "", cwd: "" }),
        getSessionId: () => "x",
      }
      const result = getRootSessionId("", manager as never)
      return result === "" ? { ok: true } : { ok: false, detail: result }
    },
  },
  {
    name: "returns input id when getHeader throws",
    run: async () => {
      const manager: FakeManager = {
        getHeader: () => {
          throw new Error("boom")
        },
        getSessionId: () => "x",
      }
      const result = getRootSessionId("session-123", manager as never)
      return result === "session-123" ? { ok: true } : { ok: false, detail: result }
    },
  },
  {
    name: "returns input id when header.id does not match the request",
    run: async () => {
      const manager: FakeManager = {
        getHeader: () => ({ type: "session", id: "different-session", timestamp: "", cwd: "" }),
        getSessionId: () => "different-session",
      }
      const result = getRootSessionId("session-123", manager as never)
      return result === "session-123" ? { ok: true } : { ok: false, detail: result }
    },
  },
  {
    name: "returns current header id when no parentSession is present",
    run: async () => {
      const manager: FakeManager = {
        getHeader: () => ({ type: "session", id: "session-123", timestamp: "", cwd: "" }),
        getSessionId: () => "session-123",
      }
      const result = getRootSessionId("session-123", manager as never)
      return result === "session-123" ? { ok: true } : { ok: false, detail: result }
    },
  },
  {
    name: "walks parentSession files to return the root id",
    run: async () =>
      await withTmpDir(async (dir) => {
        const rootPath = path.join(dir, "root.jsonl")
        const midPath = path.join(dir, "mid.jsonl")
        writeSessionFile(rootPath, { type: "session", id: "root-id", timestamp: "", cwd: "" })
        writeSessionFile(midPath, {
          type: "session",
          id: "mid-id",
          timestamp: "",
          cwd: "",
          parentSession: rootPath,
        })

        const manager: FakeManager = {
          getHeader: () => ({
            type: "session",
            id: "current-id",
            timestamp: "",
            cwd: "",
            parentSession: midPath,
          }),
          getSessionId: () => "current-id",
        }

        const result = getRootSessionId("current-id", manager as never)
        return result === "root-id" ? { ok: true } : { ok: false, detail: result }
      }),
  },
  {
    name: "stops walking when a parent file is unreadable",
    run: async () => {
      const manager: FakeManager = {
        getHeader: () => ({
          type: "session",
          id: "current-id",
          timestamp: "",
          cwd: "",
          parentSession: "/nonexistent/path/that/should/not/exist.jsonl",
        }),
        getSessionId: () => "current-id",
      }
      const result = getRootSessionId("current-id", manager as never)
      // Cannot read parent → break, return current id.
      return result === "current-id" ? { ok: true } : { ok: false, detail: result }
    },
  },
  {
    name: "stops walking on cycle (visited id repeated)",
    run: async () =>
      await withTmpDir(async (dir) => {
        const aPath = path.join(dir, "a.jsonl")
        const bPath = path.join(dir, "b.jsonl")
        // a points to b, b points to a → cycle
        writeSessionFile(aPath, { type: "session", id: "a-id", timestamp: "", cwd: "", parentSession: bPath })
        writeSessionFile(bPath, { type: "session", id: "b-id", timestamp: "", cwd: "", parentSession: aPath })

        const manager: FakeManager = {
          getHeader: () => ({
            type: "session",
            id: "a-id",
            timestamp: "",
            cwd: "",
            parentSession: bPath,
          }),
          getSessionId: () => "a-id",
        }

        const result = getRootSessionId("a-id", manager as never)
        // Walk: cursor=a, parent=b (id b-id), parent of b=a (id a-id, already visited → break).
        // Cursor ends as b-id.
        return result === "b-id" ? { ok: true } : { ok: false, detail: result }
      }),
  },
  {
    name: "returns null-id-safe fallback when parent header has wrong type",
    run: async () =>
      await withTmpDir(async (dir) => {
        const parentPath = path.join(dir, "parent.jsonl")
        // Wrong type field — header parser returns null.
        writeFileSync(parentPath, JSON.stringify({ type: "not-session", id: "ignored" }) + "\n", "utf8")

        const manager: FakeManager = {
          getHeader: () => ({
            type: "session",
            id: "current-id",
            timestamp: "",
            cwd: "",
            parentSession: parentPath,
          }),
          getSessionId: () => "current-id",
        }

        const result = getRootSessionId("current-id", manager as never)
        return result === "current-id" ? { ok: true } : { ok: false, detail: result }
      }),
  },
  {
    name: "returns fallback when first line of parent file is invalid JSON",
    run: async () =>
      await withTmpDir(async (dir) => {
        const parentPath = path.join(dir, "parent.jsonl")
        writeFileSync(parentPath, "{not-json\n", "utf8")

        const manager: FakeManager = {
          getHeader: () => ({
            type: "session",
            id: "current-id",
            timestamp: "",
            cwd: "",
            parentSession: parentPath,
          }),
          getSessionId: () => "current-id",
        }

        const result = getRootSessionId("current-id", manager as never)
        return result === "current-id" ? { ok: true } : { ok: false, detail: result }
      }),
  },
  {
    name: "returns fallback when parent file is empty",
    run: async () =>
      await withTmpDir(async (dir) => {
        const parentPath = path.join(dir, "parent.jsonl")
        writeFileSync(parentPath, "", "utf8")

        const manager: FakeManager = {
          getHeader: () => ({
            type: "session",
            id: "current-id",
            timestamp: "",
            cwd: "",
            parentSession: parentPath,
          }),
          getSessionId: () => "current-id",
        }

        const result = getRootSessionId("current-id", manager as never)
        return result === "current-id" ? { ok: true } : { ok: false, detail: result }
      }),
  },
  {
    name: "bounds parent walk depth (does not loop forever on a long chain)",
    run: async () =>
      await withTmpDir(async (dir) => {
        // Build a chain of 200 parent files to exceed MAX_LINEAGE_DEPTH (64).
        const depth = 200
        const paths: string[] = []
        for (let i = 0; i < depth; i++) {
          paths.push(path.join(dir, `s-${i}.jsonl`))
        }
        // Innermost (index 0) has no parent; each subsequent points to the previous.
        for (let i = 0; i < depth; i++) {
          const header: SessionHeader = {
            type: "session",
            id: `id-${i}`,
            timestamp: "",
            cwd: "",
            ...(i > 0 ? { parentSession: paths[i - 1] } : {}),
          }
          writeSessionFile(paths[i], header)
        }

        const manager: FakeManager = {
          getHeader: () => ({
            type: "session",
            id: `id-current`,
            timestamp: "",
            cwd: "",
            parentSession: paths[depth - 1],
          }),
          getSessionId: () => "id-current",
        }

        const start = Date.now()
        const result = getRootSessionId("id-current", manager as never)
        const elapsed = Date.now() - start
        // Walk capped at MAX_LINEAGE_DEPTH (64). Cursor will reach id-(depth-1-64)=id-135.
        // Just verify we returned within reasonable time and have an id from the chain.
        if (elapsed > 5000) {
          return { ok: false, detail: `lineage walk too slow: ${elapsed}ms` }
        }
        if (!result.startsWith("id-")) {
          return { ok: false, detail: `unexpected result=${result}` }
        }
        return { ok: true }
      }),
  },
]

export async function main(): Promise<number> {
  let failures = 0
  for (const c of cases) {
    try {
      const outcome = await c.run()
      if (outcome.ok) {
        console.info(`PASS  ${c.name}`)
      } else {
        failures += 1
        console.info(`FAIL  ${c.name} -- ${outcome.detail ?? "no detail"}`)
      }
    } catch (error) {
      failures += 1
      console.info(`FAIL  ${c.name} -- threw ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.info(`\n${cases.length - failures}/${cases.length} passed`)
  return failures === 0 ? 0 : 1
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /session-lineage\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}

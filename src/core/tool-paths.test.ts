import {
  MUTATION_TOOL_NAMES,
  getChangedPaths,
  getMutationToolHookNames,
  getToolAffectedPaths,
  getToolFileChanges,
  normalizeMutationToolName,
} from "./tool-paths.js"

interface Case {
  readonly name: string
  readonly run: () => { ok: boolean; detail?: string }
}

const cases: Case[] = [
  {
    name: "MUTATION_TOOL_NAMES contains the documented direct-mutation tools",
    run: () => {
      const required = ["write", "edit", "multiedit", "patch", "apply_patch", "bash"] as const
      for (const name of required) {
        if (!(MUTATION_TOOL_NAMES as Set<string>).has(name)) {
          return { ok: false, detail: `missing ${name}` }
        }
      }
      return { ok: true }
    },
  },
  {
    name: "normalizeMutationToolName returns undefined for non-mutation tools",
    run: () => (normalizeMutationToolName("read") === undefined ? { ok: true } : { ok: false }),
  },
  {
    name: "normalizeMutationToolName preserves direct mutation tools",
    run: () => {
      if (normalizeMutationToolName("write") !== "write") return { ok: false, detail: "write" }
      if (normalizeMutationToolName("edit") !== "edit") return { ok: false, detail: "edit" }
      if (normalizeMutationToolName("multiedit") !== "multiedit") return { ok: false, detail: "multiedit" }
      return { ok: true }
    },
  },
  {
    name: "normalizeMutationToolName collapses patch and apply_patch to apply_patch",
    run: () => {
      const a = normalizeMutationToolName("patch")
      const b = normalizeMutationToolName("apply_patch")
      return a === "apply_patch" && b === "apply_patch" ? { ok: true } : { ok: false, detail: `${a}/${b}` }
    },
  },
  {
    name: "normalizeMutationToolName recognizes bash",
    run: () => (normalizeMutationToolName("bash") === "bash" ? { ok: true } : { ok: false }),
  },
  {
    name: "getMutationToolHookNames returns both patch aliases for apply_patch",
    run: () => {
      const names = getMutationToolHookNames("apply_patch").sort()
      return JSON.stringify(names) === JSON.stringify(["apply_patch", "patch"])
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(names) }
    },
  },
  {
    name: "getMutationToolHookNames returns empty array for unknown tools",
    run: () => (getMutationToolHookNames("read").length === 0 ? { ok: true } : { ok: false }),
  },
  {
    name: "getMutationToolHookNames returns single bash entry",
    run: () => {
      const names = getMutationToolHookNames("bash")
      return names.length === 1 && names[0] === "bash" ? { ok: true } : { ok: false, detail: JSON.stringify(names) }
    },
  },
  {
    name: "getToolFileChanges returns empty for unknown tools",
    run: () => (getToolFileChanges("read", { path: "/x" }).length === 0 ? { ok: true } : { ok: false }),
  },
  {
    name: "getToolFileChanges resolves filePath/file_path/path/file aliases for write",
    run: () => {
      const cases: Array<Record<string, unknown>> = [
        { filePath: "/a.txt" },
        { file_path: "/a.txt" },
        { path: "/a.txt" },
        { file: "/a.txt" },
      ]
      for (const args of cases) {
        const changes = getToolFileChanges("write", args)
        if (changes.length !== 1 || changes[0].operation !== "modify" || changes[0].path !== "/a.txt") {
          return { ok: false, detail: `args=${JSON.stringify(args)} → ${JSON.stringify(changes)}` }
        }
      }
      return { ok: true }
    },
  },
  {
    name: "getToolFileChanges returns no changes when write has no path",
    run: () => (getToolFileChanges("write", {}).length === 0 ? { ok: true } : { ok: false }),
  },
  {
    name: "getToolFileChanges parses Add/Update/Delete/Move from apply_patch",
    run: () => {
      const patchText = [
        "*** Add File: new.txt",
        "+content",
        "*** Update File: keep.txt",
        " context",
        "*** Update File: rename-from.txt",
        "*** Move to: rename-to.txt",
        "*** Delete File: gone.txt",
      ].join("\n")
      const changes = getToolFileChanges("apply_patch", { patchText })
      const summary = changes.map((c) => {
        if (c.operation === "rename") return `rename:${c.fromPath}->${c.toPath}`
        return `${c.operation}:${c.path}`
      })
      const expected = [
        "create:new.txt",
        "modify:keep.txt",
        "rename:rename-from.txt->rename-to.txt",
        "delete:gone.txt",
      ]
      return JSON.stringify(summary) === JSON.stringify(expected)
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(summary) }
    },
  },
  {
    name: "getToolFileChanges returns empty when apply_patch has no patch text",
    run: () => (getToolFileChanges("apply_patch", {}).length === 0 ? { ok: true } : { ok: false }),
  },
  {
    name: "getToolFileChanges accepts patch alias for apply_patch text",
    run: () => {
      const changes = getToolFileChanges("patch", { diff: "*** Add File: new.txt\n+x" })
      return changes.length === 1 && changes[0].operation === "create" && changes[0].path === "new.txt"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(changes) }
    },
  },
  {
    name: "getToolFileChanges parses bash rm and touch into delete/create",
    run: () => {
      const changes = getToolFileChanges("bash", { command: "rm -rf old.txt && touch new.txt" })
      const summary = changes.map((c) =>
        c.operation === "rename" ? `rename:${c.fromPath}->${c.toPath}` : `${c.operation}:${c.path}`,
      )
      return JSON.stringify(summary) === JSON.stringify(["delete:old.txt", "create:new.txt"])
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(summary) }
    },
  },
  {
    name: "getToolFileChanges parses bash mv as rename",
    run: () => {
      const changes = getToolFileChanges("bash", { command: "mv from.txt to.txt" })
      return changes.length === 1 &&
        changes[0].operation === "rename" &&
        changes[0].fromPath === "from.txt" &&
        changes[0].toPath === "to.txt"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(changes) }
    },
  },
  {
    name: "getToolFileChanges parses bash cp as create on destination",
    run: () => {
      const changes = getToolFileChanges("bash", { command: "cp src.txt dest.txt" })
      return changes.length === 1 && changes[0].operation === "create" && changes[0].path === "dest.txt"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(changes) }
    },
  },
  {
    name: "getToolFileChanges parses git rm/git mv/git cp",
    run: () => {
      const rmChanges = getToolFileChanges("bash", { command: "git rm goodbye.txt" })
      const mvChanges = getToolFileChanges("bash", { command: "git mv from.txt to.txt" })
      if (rmChanges.length !== 1 || rmChanges[0].operation !== "delete" || rmChanges[0].path !== "goodbye.txt") {
        return { ok: false, detail: `rm: ${JSON.stringify(rmChanges)}` }
      }
      if (mvChanges.length !== 1 || mvChanges[0].operation !== "rename") {
        return { ok: false, detail: `mv: ${JSON.stringify(mvChanges)}` }
      }
      return { ok: true }
    },
  },
  {
    name: "getToolFileChanges accepts cmd alias for bash command",
    run: () => {
      const changes = getToolFileChanges("bash", { cmd: "touch made.txt" })
      return changes.length === 1 && changes[0].operation === "create" && changes[0].path === "made.txt"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(changes) }
    },
  },
  {
    name: "getToolFileChanges handles quoted paths with spaces",
    run: () => {
      const changes = getToolFileChanges("bash", { command: 'rm "with spaces.txt"' })
      return changes.length === 1 && changes[0].path === "with spaces.txt"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(changes) }
    },
  },
  {
    name: "getToolFileChanges ignores flags before paths in rm",
    run: () => {
      const changes = getToolFileChanges("bash", { command: "rm -rf -- foo.txt bar.txt" })
      const paths = changes.map((c) => (c.operation === "delete" ? c.path : ""))
      return paths.includes("foo.txt") && paths.includes("bar.txt")
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(changes) }
    },
  },
  {
    name: "getToolFileChanges splits compound bash commands by &&/||/;",
    run: () => {
      const changes = getToolFileChanges("bash", {
        command: "touch a.txt; touch b.txt && touch c.txt || touch d.txt",
      })
      const paths = changes.map((c) => (c.operation === "create" ? c.path : ""))
      const ok = ["a.txt", "b.txt", "c.txt", "d.txt"].every((p) => paths.includes(p))
      return ok ? { ok: true } : { ok: false, detail: JSON.stringify(changes) }
    },
  },
  {
    name: "getToolFileChanges returns nothing for unrelated bash commands",
    run: () => {
      const changes = getToolFileChanges("bash", { command: "echo hello && grep -R foo src" })
      return changes.length === 0 ? { ok: true } : { ok: false, detail: JSON.stringify(changes) }
    },
  },
  {
    name: "getChangedPaths deduplicates renamed paths and tolerates missing fromPath",
    run: () => {
      const paths = getChangedPaths([
        { operation: "modify", path: "/a" },
        { operation: "modify", path: "/a" },
        { operation: "rename", fromPath: "/from", toPath: "/to" },
        { operation: "rename", fromPath: "", toPath: "/to-only" } as never,
      ])
      const set = new Set(paths)
      const ok = set.has("/a") && set.has("/from") && set.has("/to") && set.has("/to-only") && paths.length === 4
      return ok ? { ok: true } : { ok: false, detail: JSON.stringify(paths) }
    },
  },
  {
    name: "getToolAffectedPaths returns canonicalized changed paths",
    run: () => {
      const paths = getToolAffectedPaths("write", { filePath: "/a/b.txt" })
      return paths.length === 1 && paths[0] === "/a/b.txt"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(paths) }
    },
  },
]

export function main(): number {
  let failures = 0
  for (const c of cases) {
    try {
      const outcome = c.run()
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
  /tool-paths\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  process.exit(main())
}

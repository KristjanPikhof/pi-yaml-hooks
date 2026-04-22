import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { executeBashHook, resetExecutionContextCacheForTests, resolveExecutionContext } from "./bash-executor.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const cases: Case[] = [
  {
    name: "execution context cache reuses git probe results across the same worktree",
    run: async () => {
      resetExecutionContextCacheForTests()
      let calls = 0
      const resolver = {
        execFileSync: (_command: string, _args: string[], options: { cwd: string }) => {
          calls += 1
          return `/repo\n${options.cwd === "/repo" ? ".git" : "../.git"}`
        },
      }

      const first = resolveExecutionContext("/repo/packages/a", resolver as never)
      const second = resolveExecutionContext("/repo/packages/b", resolver as never)

      return calls === 1 && first.worktreeDir === "/repo" && second.worktreeDir === "/repo"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify({ calls, first, second }) }
    },
  },
  {
    name: "execution context cache reuses non-git fallback for the same project directory",
    run: async () => {
      resetExecutionContextCacheForTests()
      let calls = 0
      const resolver = {
        execFileSync: () => {
          calls += 1
          throw new Error("not a git repo")
        },
      }

      const first = resolveExecutionContext("/tmp/no-git", resolver as never)
      const second = resolveExecutionContext("/tmp/no-git", resolver as never)

      return calls === 1 && !first.resolvedFromGit && second.worktreeDir === "/tmp/no-git"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify({ calls, first, second }) }
    },
  },
  {
    name: "timed out bash hooks kill descendant background processes on POSIX",
    run: async () => {
      if (process.platform === "win32") {
        return { ok: true }
      }

      const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-hooks-bash-timeout-"))
      const pidFile = path.join(tempDir, "child.pid")

      try {
        const result = await executeBashHook({
          command:
            `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)' ` +
            `& child=$!; printf "%s" "$child" > ${JSON.stringify(pidFile)}; wait $child`,
          timeout: 150,
          projectDir: tempDir,
          context: {
            session_id: "s1",
            event: "tool.after.bash",
            cwd: tempDir,
          },
        })

        const childPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
        await sleep(500)
        const childAlive = Number.isFinite(childPid) ? isProcessAlive(childPid) : true

        const sawCleanupDetails =
          /process group/i.test(result.stderr) &&
          /SIGTERM/i.test(result.stderr) &&
          /SIGKILL/i.test(result.stderr) &&
          /final result/i.test(result.stderr)

        return result.status === "timed_out" && result.timedOut && !childAlive && sawCleanupDetails
          ? { ok: true }
          : {
              ok: false,
              detail: JSON.stringify({
                status: result.status,
                timedOut: result.timedOut,
                childPid,
                childAlive,
                stderr: result.stderr,
              }),
            }
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  },
]

export async function main(): Promise<number> {
  let failures = 0
  resetExecutionContextCacheForTests()
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
  /bash-executor\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}

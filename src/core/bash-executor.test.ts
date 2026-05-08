import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  executeBashHook,
  redactSensitiveContent,
  resetExecutionContextCacheForTests,
  resolveExecutionContext,
  serializeContextForStdin,
  setExecutionContextNowForTests,
  trimToUtf8Boundary,
} from "./bash-executor.js"
import { TIMEOUT_EXIT_CODE } from "./bash-types.js"
import {
  flushPiHooksLoggerForTests,
  getPiHooksLoggerDrainCountForTests,
  getPiHooksLogger,
  resetPiHooksLoggerForTests,
} from "./logger.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  // process.kill(pid, 0) returns true for zombies (the kernel keeps the entry
  // around until the parent waits on it). For our tests "the process is no
  // longer running" is the relevant predicate, so we explicitly classify
  // state Z as dead by inspecting /proc on Linux and `ps -o stat` on macOS.
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  const state = readProcessState(pid)
  if (state === undefined) {
    // We couldn't read the state — fall back to the kill(0) result, which
    // means the kernel still has an entry for this pid.
    return true
  }
  // Z = zombie, X = dead. Anything else (R, S, D, T, ...) is "still around".
  return state !== "Z" && state !== "X"
}

function readProcessState(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
      // Format: "<pid> (comm) <state> ..." — comm can contain spaces and
      // close-paren so look for the LAST close-paren and read the next field.
      const lastParen = raw.lastIndexOf(")")
      if (lastParen < 0) return undefined
      const after = raw.slice(lastParen + 1).trim()
      const stateChar = after.split(/\s+/)[0]
      return stateChar?.charAt(0)
    } catch {
      return undefined
    }
  }
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      const trimmed = raw.trim()
      if (!trimmed) return undefined
      // macOS ps state codes start with one of R, S, I, T, U, Z. Take the
      // first character so we ignore modifiers like '+' and 'N'.
      return trimmed.charAt(0)
    } catch {
      return undefined
    }
  }
  return undefined
}

async function waitForNonEmptyFile(filePath: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (existsSync(filePath)) {
        const contents = readFileSync(filePath, "utf8").trim()
        if (contents.length > 0) return contents
      }
    } catch {
      // ignore — keep polling
    }
    await sleep(50)
  }
  return undefined
}

function expectRedacted(input: string, mustNotContain: string[]): { ok: boolean; detail?: string } {
  const out = redactSensitiveContent(input)
  for (const needle of mustNotContain) {
    if (out.includes(needle)) {
      return { ok: false, detail: `expected no '${needle}' in ${JSON.stringify(out)}` }
    }
  }
  if (!out.includes("[REDACTED]")) {
    return { ok: false, detail: `expected '[REDACTED]' marker in ${JSON.stringify(out)}` }
  }
  return { ok: true }
}

const cases: Case[] = [
  {
    name: "redacts GitHub personal access tokens (ghp_)",
    run: async () => expectRedacted("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"]),
  },
  {
    name: "redacts GitHub fine-grained PATs (github_pat_)",
    run: async () => expectRedacted("github_pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyz0123456789", ["abcdefghijklmnopqrstuvwxyz0123456789"]),
  },
  {
    name: "redacts GitLab personal access tokens (glpat-)",
    run: async () => expectRedacted("export FOO=glpat-abcdefghijklmnop1234", ["glpat-abcdefghijklmnop1234"]),
  },
  {
    name: "redacts Slack bot tokens (xoxb-)",
    run: async () => expectRedacted("slack=xoxb-1234567890-1234567890-AbCdEfGhIjKlMnOp", ["xoxb-1234567890-1234567890-AbCdEfGhIjKlMnOp"]),
  },
  {
    name: "redacts Slack user tokens (xoxp-)",
    run: async () => expectRedacted("xoxp-9876543210-fakeslackuserstring", ["xoxp-9876543210-fakeslackuserstring"]),
  },
  {
    name: "redacts Slack admin/legacy app tokens (xoxa-)",
    run: async () => expectRedacted("xoxa-2-foobarbazsecret123", ["foobarbazsecret123"]),
  },
  {
    name: "redacts basic-auth URLs (https://user:pass@host)",
    run: async () => expectRedacted("connecting to https://alice:hunter2@example.com/path", ["hunter2"]),
  },
  {
    name: "redacts basic-auth in postgres://user:pass@host",
    run: async () => expectRedacted("DB=postgres://user:supersecretpw@db.example.com:5432/x", ["supersecretpw"]),
  },
  {
    name: "redacts JWT (three base64url segments separated by dots)",
    run: async () => expectRedacted(
      "auth=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ["SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
    ),
  },
  {
    name: "redacts uppercase env-style names ending in TOKEN/SECRET/KEY/PASSWORD",
    run: async () => {
      const cases = [
        "GITHUB_TOKEN=abcdef12345",
        "AWS_SECRET_ACCESS_KEY=verysecretvalue",
        "MY_API_KEY=zxc987",
        "DATABASE_PASSWORD=p@ssw0rd",
      ]
      for (const input of cases) {
        const out = redactSensitiveContent(input)
        if (out.includes("abcdef12345") || out.includes("verysecretvalue") || out.includes("zxc987") || out.includes("p@ssw0rd")) {
          return { ok: false, detail: `leak in ${input} -> ${out}` }
        }
        if (!out.includes("[REDACTED]")) {
          return { ok: false, detail: `no marker in ${out}` }
        }
      }
      return { ok: true }
    },
  },
  {
    name: "redacts PEM private key blocks",
    run: async () => {
      const pem = [
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
        "MZeBESxhfakekeymaterialfortest==",
        "-----END PRIVATE KEY-----",
      ].join("\n")
      const out = redactSensitiveContent(`prefix\n${pem}\nsuffix`)
      if (out.includes("fakekeymaterialfortest")) {
        return { ok: false, detail: `leaked PEM body: ${out}` }
      }
      if (!out.includes("[REDACTED]")) {
        return { ok: false, detail: `no marker: ${out}` }
      }
      return { ok: true }
    },
  },
  {
    name: "stdin context serializer truncates oversized payloads with marker",
    run: async () => {
      const huge = "x".repeat(2_000_000) // ~2 MiB string field
      const out = serializeContextForStdin({
        session_id: "s1",
        event: "tool.after.write",
        cwd: "/repo",
        // @ts-expect-error — extra fields are allowed by the actual context shape
        toolArgs: { path: "/repo/file.txt", content: huge },
      })
      const parsed = JSON.parse(out) as Record<string, unknown>
      const ok =
        Buffer.byteLength(out, "utf8") <= 262_144 &&
        parsed._pi_hooks_truncated === true &&
        typeof parsed._pi_hooks_original_byte_length === "number" &&
        (parsed._pi_hooks_original_byte_length as number) > 1_000_000 &&
        parsed.session_id === "s1" &&
        parsed.event === "tool.after.write" &&
        parsed.cwd === "/repo"
      return ok ? { ok: true } : { ok: false, detail: `out.byteLength=${Buffer.byteLength(out, "utf8")} parsed=${JSON.stringify(parsed).slice(0, 300)}` }
    },
  },
  {
    name: "stdin context serializer passes small payloads through unchanged",
    run: async () => {
      const ctx = { session_id: "s1", event: "tool.after.write", cwd: "/repo" } as const
      const out = serializeContextForStdin(ctx)
      const parsed = JSON.parse(out) as Record<string, unknown>
      return parsed.session_id === "s1" && parsed._pi_hooks_truncated === undefined
        ? { ok: true }
        : { ok: false, detail: out }
    },
  },
  {
    name: "redacts RSA-typed PEM private key blocks",
    run: async () => {
      const pem = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "fakekeymaterialfortest1234567890",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n")
      const out = redactSensitiveContent(pem)
      return out.includes("[REDACTED]") && !out.includes("fakekeymaterialfortest1234567890")
        ? { ok: true }
        : { ok: false, detail: out }
    },
  },
  {
    name: "execution context cache reuses git probe results across the same worktree",
    run: async () => {
      resetExecutionContextCacheForTests()
      let calls = 0
      const resolver = {
        execFileSync: (_command: string, _args: string[], options: { cwd: string }) => {
          calls += 1
          return `/repo\n${options.cwd === "/repo" ? ".git" : "../../.git"}`
        },
      }

      const first = resolveExecutionContext("/repo/packages/a", resolver as never)
      const second = resolveExecutionContext("/repo/packages/a", resolver as never)

      return calls === 1 && first.worktreeDir === "/repo" && second.worktreeDir === "/repo"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify({ calls, first, second }) }
    },
  },
  {
    name: "execution context does not reuse a parent repo cache for nested repos",
    run: async () => {
      resetExecutionContextCacheForTests()
      let calls = 0
      const resolver = {
        execFileSync: (_command: string, _args: string[], options: { cwd: string }) => {
          calls += 1
          return options.cwd.startsWith("/repo/submodule") ? "/repo/submodule\n.git" : "/repo\n.git"
        },
      }

      const parent = resolveExecutionContext("/repo", resolver as never)
      const nested = resolveExecutionContext("/repo/submodule", resolver as never)

      return calls === 2 && parent.worktreeDir === "/repo" && nested.worktreeDir === "/repo/submodule"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify({ calls, parent, nested }) }
    },
  },
  {
    name: "execution context retries git resolution after a transient failure",
    run: async () => {
      resetExecutionContextCacheForTests()
      let calls = 0
      const resolver = {
        execFileSync: () => {
          calls += 1
          if (calls === 1) {
            throw new Error("temporary failure")
          }
          return "/repo\n.git"
        },
      }

      const first = resolveExecutionContext("/repo", resolver as never)
      const second = resolveExecutionContext("/repo", resolver as never)

      return calls === 2 && !first.resolvedFromGit && second.resolvedFromGit && second.worktreeDir === "/repo"
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

      const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-bash-timeout-"))
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

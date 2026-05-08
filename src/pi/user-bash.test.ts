import { generateCallId, _resetUserBashWarningForTests, _emitUserBashWarningOnce } from "./user-bash.js"

interface Case {
  readonly name: string
  readonly run: () => { ok: boolean; detail?: string }
}

const cases: Case[] = [
  {
    name: "generateCallId returns a non-empty string",
    run: () => {
      const id = generateCallId()
      return typeof id === "string" && id.length > 0
        ? { ok: true }
        : { ok: false, detail: `got ${JSON.stringify(id)}` }
    },
  },
  {
    name: "generateCallId produces unique values in same-millisecond burst",
    run: () => {
      // Generate a burst of IDs without any delay to guarantee same-millisecond
      // execution. With Date.now() these would be identical; with randomUUID
      // they must all be distinct.
      const N = 1000
      const ids = new Set<string>()
      for (let i = 0; i < N; i++) {
        ids.add(generateCallId())
      }
      return ids.size === N
        ? { ok: true }
        : { ok: false, detail: `only ${ids.size} unique IDs out of ${N}` }
    },
  },
  {
    name: "generateCallId values look like UUIDs (v4 format)",
    run: () => {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      const id = generateCallId()
      return uuidRe.test(id)
        ? { ok: true }
        : { ok: false, detail: `id does not look like a v4 UUID: ${id}` }
    },
  },
  {
    name: "user_bash warning fires exactly once per process when called multiple times",
    run: () => {
      _resetUserBashWarningForTests()
      const lines: string[] = []
      const original = process.stderr.write.bind(process.stderr)
      ;(process.stderr as unknown as { write: typeof process.stderr.write }).write = (
        chunk: unknown,
        ...args: unknown[]
      ): boolean => {
        if (typeof chunk === "string") lines.push(chunk)
        return original(chunk as Parameters<typeof process.stderr.write>[0])
      }

      try {
        _emitUserBashWarningOnce()
        _emitUserBashWarningOnce()
        _emitUserBashWarningOnce()
      } finally {
        ;(process.stderr as unknown as { write: typeof process.stderr.write }).write = original
        _resetUserBashWarningForTests()
      }

      const warningLines = lines.filter((l) => l.includes("PI_HOOKS_ENABLE_USER_BASH"))
      return warningLines.length === 1
        ? { ok: true }
        : { ok: false, detail: `expected 1 warning line, got ${warningLines.length}` }
    },
  },
  {
    name: "user_bash warning text includes trust expansion risks",
    run: () => {
      _resetUserBashWarningForTests()
      let captured = ""
      const original = process.stderr.write.bind(process.stderr)
      ;(process.stderr as unknown as { write: typeof process.stderr.write }).write = (
        chunk: unknown,
        ...args: unknown[]
      ): boolean => {
        if (typeof chunk === "string") captured += chunk
        return original(chunk as Parameters<typeof process.stderr.write>[0])
      }

      try {
        _emitUserBashWarningOnce()
      } finally {
        ;(process.stderr as unknown as { write: typeof process.stderr.write }).write = original
        _resetUserBashWarningForTests()
      }

      const requiredPhrases = ["observe", "block", "exfiltrat", "PI_TOOL_ARGS"]
      const missing = requiredPhrases.filter((p) => !captured.includes(p))
      return missing.length === 0
        ? { ok: true }
        : { ok: false, detail: `warning missing phrases: ${missing.join(", ")}` }
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
  /user-bash\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  process.exit(main())
}

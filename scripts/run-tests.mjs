#!/usr/bin/env node
// Internal test runner for `npm run test:internal`.
//
// Walks `dist/` for compiled `*.test.js` files and runs them under
// `node --test`. Asserts a non-zero count so that a build that produces
// zero tests fails loudly instead of silently passing.
//
// We deliberately do not use `node --test 'dist/**/*.test.js'` because
// node's built-in glob handling differs across the supported node range,
// and we want an explicit count guard regardless.

import { spawn } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distDir = path.join(repoRoot, "dist")

async function walk(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === "ENOENT") return out
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(full)))
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      out.push(full)
    }
  }
  return out
}

async function main() {
  let distExists = false
  try {
    const s = await stat(distDir)
    distExists = s.isDirectory()
  } catch {
    distExists = false
  }
  if (!distExists) {
    console.error(`[run-tests] dist/ not found at ${distDir}; run \`npm run build\` first.`)
    process.exit(1)
  }

  const tests = (await walk(distDir)).sort()
  if (tests.length === 0) {
    console.error(`[run-tests] no compiled test files matched ${distDir}/**/*.test.js`)
    console.error("[run-tests] aborting so a missing build does not silently pass.")
    process.exit(1)
  }

  console.log(`[run-tests] discovered ${tests.length} test file(s) under dist/`)

  // Pass each compiled test file to node --test as a positional argument.
  // node executes them sequentially in one process group, which keeps signal
  // handling sane when the developer hits Ctrl-C mid-run.
  const child = spawn(process.execPath, ["--test", ...tests], {
    stdio: "inherit",
    cwd: repoRoot,
  })
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[run-tests] node --test killed by ${signal}`)
      process.exit(1)
    }
    process.exit(code ?? 1)
  })
}

main().catch((err) => {
  console.error("[run-tests] unexpected failure:", err)
  process.exit(1)
})

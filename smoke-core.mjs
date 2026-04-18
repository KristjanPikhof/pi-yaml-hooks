// Smoke test for the ported pi-hooks core modules.
// Loads a trivial hooks.yaml via loadHooksFile and parseHooksFile, and verifies
// the returned HookMap is shaped correctly.
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Use tsc to emit the core files to a temp dir, then import.
import { execFileSync } from "node:child_process"

// Emit into a dir inside the project so Node resolves 'yaml' from the project's
// node_modules.
const tmp = mkdtempSync(path.join(process.cwd(), ".pi-hooks-smoke-"))
try {
  execFileSync(
    "npx",
    [
      "--yes",
      "-p",
      "typescript@5.9.3",
      "tsc",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--outDir",
      tmp,
      "--declaration",
      "false",
      "--skipLibCheck",
      "--strict",
      "src/core/types.ts",
      "src/core/bash-types.ts",
      "src/core/config-paths.ts",
      "src/core/load-hooks.ts",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  )

  const hooksYamlPath = path.join(tmp, "hooks.yaml")
  writeFileSync(
    hooksYamlPath,
    [
      "hooks:",
      '  - event: "tool.after.write"',
      "    actions:",
      '      - bash: "echo hello from smoke test"',
      "",
    ].join("\n"),
  )

  // tsc places outputs mirroring the common rootDir structure; since all inputs
  // are under src/core/, outputs end up in <tmp>/src/core/*.js (or <tmp>/core/*.js
  // depending on tsc's inferred rootDir). Probe both.
  const candidates = [
    path.join(tmp, "src", "core", "load-hooks.js"),
    path.join(tmp, "core", "load-hooks.js"),
    path.join(tmp, "load-hooks.js"),
  ]
  const { existsSync } = await import("node:fs")
  const loadHooksJs = candidates.find((p) => existsSync(p))
  if (!loadHooksJs) {
    console.error("SMOKE FAIL: could not find compiled load-hooks.js in", candidates)
    process.exit(1)
  }
  const mod = await import(loadHooksJs)
  const { loadHooksFile } = mod

  const result = loadHooksFile(hooksYamlPath)
  if (result.errors.length > 0) {
    console.error("SMOKE FAIL: validation errors", result.errors)
    process.exit(1)
  }
  if (!(result.hooks instanceof Map)) {
    console.error("SMOKE FAIL: hooks is not a Map")
    process.exit(1)
  }
  const configs = result.hooks.get("tool.after.write")
  if (!configs || configs.length !== 1) {
    console.error("SMOKE FAIL: expected 1 hook config for tool.after.write, got", configs)
    process.exit(1)
  }
  const cfg = configs[0]
  if (cfg.actions.length !== 1 || !("bash" in cfg.actions[0])) {
    console.error("SMOKE FAIL: expected 1 bash action, got", cfg.actions)
    process.exit(1)
  }

  console.log("SMOKE OK:")
  console.log("  event:", cfg.event)
  console.log("  scope:", cfg.scope)
  console.log("  runIn:", cfg.runIn)
  console.log("  actions:", JSON.stringify(cfg.actions))
  console.log("  hooks map size:", result.hooks.size)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

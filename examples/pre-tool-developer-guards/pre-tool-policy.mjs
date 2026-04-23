#!/usr/bin/env node

const payload = JSON.parse(await readStdin())
const packageInstallOnly = process.argv.includes("--package-install-only")
const toolName = String(payload.tool_name ?? "")
const toolArgs = isRecord(payload.tool_args) ? payload.tool_args : {}

if (toolName === "bash") {
  const command = String(toolArgs.command ?? "")
  const reason = packageInstallOnly ? getPackageInstallReason(command) : getRiskyCommandReason(command)
  if (reason) {
    block(reason)
  }
}

if (toolName === "write" || toolName === "edit") {
  const filePath = String(toolArgs.path ?? toolArgs.filePath ?? toolArgs.file_path ?? toolArgs.file ?? "")
  if (isProtectedPath(filePath)) {
    block(`Blocked ${toolName} to protected path: ${filePath}`)
  }
}

function getRiskyCommandReason(command) {
  const compact = command.replace(/\s+/g, " ").trim()
  const rules = [
    [/(\s|^)git\s+reset\s+--hard(\s|$)/, "Blocked git reset --hard"],
    [/(\s|^)git\s+clean\s+-[^\n;]*f[^\n;]*d/, "Blocked destructive git clean"],
    [/(\s|^)rm\s+-[^\n;]*r[^\n;]*f\s+(\/|\$HOME|~)(\s|$)/, "Blocked broad rm -rf target"],
    [/(\s|^)chmod\s+-R\s+777(\s|$)/, "Blocked recursive chmod 777"],
    [/(curl|wget)[^|;&]*\|\s*(sh|bash)(\s|$)/, "Blocked pipe-to-shell install command"],
  ]

  return rules.find(([pattern]) => pattern.test(compact))?.[1]
}

function getPackageInstallReason(command) {
  const compact = command.replace(/\s+/g, " ").trim()
  const rules = [
    [/(\s|^)(npm|pnpm|yarn)\s+(install|add|update|upgrade)(\s|$)/, "Blocked package install/update command"],
    [/(\s|^)bun\s+(install|add|update)(\s|$)/, "Blocked package install/update command"],
    [/(\s|^)pipx?\s+install(\s|$)/, "Blocked Python package install command"],
    [/(\s|^)uv\s+(add|sync|pip\s+install)(\s|$)/, "Blocked Python dependency update command"],
    [/(\s|^)cargo\s+(add|install|update)(\s|$)/, "Blocked Rust dependency update command"],
    [/(\s|^)go\s+get(\s|$)/, "Blocked Go dependency update command"],
  ]

  return rules.find(([pattern]) => pattern.test(compact))?.[1]
}

function isProtectedPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "")
  return normalized === ".env"
    || normalized.startsWith(".env.")
    || normalized.endsWith(".pem")
    || normalized.endsWith(".key")
    || normalized.endsWith(".p12")
    || normalized.includes("/.ssh/")
    || normalized.includes("/secrets/")
}

function block(message) {
  console.error(message)
  process.exit(2)
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

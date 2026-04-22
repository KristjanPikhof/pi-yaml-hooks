# pi-hooks

`pi-hooks` adds YAML-driven hooks to the [PI coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent). You can run `bash` around tool calls and session events, block risky actions before they run, and surface PI-native notifications, confirmations, and status entries from `hooks.yaml`.

This repo is the PI port of OpenCode-Hooks. The hook model is familiar, but the runtime is PI-native and the limits are explicit.

## What it does

- Run hooks on `tool.before.*`, `tool.after.*`, `file.changed`, `session.created`, `session.idle`, and `session.deleted`
- Use `bash`, `tool`, `notify`, `confirm`, and `setStatus` actions
- Filter hooks with `matchesCodeFiles`, `matchesAnyPath`, and `matchesAllPaths`
- Load one global root config and one trusted project root config, each with top-level `imports:`
- Show built-in diagnostics with `/hooks-status`, `/hooks-validate`, `/hooks-trust`, `/hooks-reload`, and `/hooks-tail-log`
- Emit structured in-session diagnostics when PI supports custom messages
- Inject a short hook-awareness note before agent start (disable with `PI_HOOKS_PROMPT_AWARENESS=0`)

## Requirements

- macOS or Linux
- Node.js `>=22.0.0`
- `bash` on `$PATH` (override with `PI_HOOKS_BASH_EXECUTABLE`)
- `@mariozechner/pi-coding-agent ^0.68.1 || ^0.69.0`

Windows is unsupported.

## Install

`pi-hooks` is installable as a PI package straight from git. That is the recommended path. PI clones the repo, installs dependencies, and loads the extension declared in `package.json`.

### Option 1: `pi install` (recommended)

```bash
# SSH
pi install git:git@github.com:KristjanPikhof/pi-yaml-hooks

# HTTPS
pi install https://github.com/KristjanPikhof/pi-yaml-hooks
```

This writes to global settings at `~/.pi/agent/settings.json`. Add `-l` to write to project settings at `.pi/settings.json` instead.

### Option 2: edit `settings.json` by hand

Add the package source to the `packages` array. PI auto-installs missing project packages on startup.

**Global**, in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:git@github.com:KristjanPikhof/pi-yaml-hooks"
  ]
}
```

**Project-local**, in `.pi/settings.json`:

```json
{
  "packages": [
    "git:git@github.com:KristjanPikhof/pi-yaml-hooks"
  ]
}
```

### Option 3: one-off trial

```bash
pi -e git:git@github.com:KristjanPikhof/pi-yaml-hooks
```

This loads `pi-hooks` for the current run only. Nothing is written to settings.

### Local development from a checkout

If you are editing this repo locally, the symlink workflow is still useful:

| Method | When to use |
|---|---|
| `ln -s "$PWD/src/index.ts" ~/.pi/agent/extensions/pi-hooks.ts` | Local development with a checked-out repo. |
| `pi -e /path/to/pi-hooks/src/index.ts` | One-off local testing from a checkout. |
| `<project>/.pi/extensions/pi-hooks.ts` | Project-local local-dev install from a checkout. |

## Quick start

Create a minimal global hook file so you can see the extension working right away.

```bash
mkdir -p ~/.pi/agent/hook
cat > ~/.pi/agent/hook/hooks.yaml <<'YAML'
hooks:
  - event: session.idle
    actions:
      - notify: "Agent is idle"
YAML

pi
```

Expected startup output:

```text
[pi-hooks] Loaded 1 hook (global: 1, project: 0).
```

If a trusted project also has project hooks, the summary includes both scopes.

```text
[pi-hooks] Loaded 3 hooks (global: 1, project: 2).
```

## How it works

`pi-hooks` discovers at most one global root config and one project root config. Each root file can import more hook files with top-level `imports:`. The project root is repo/worktree-aware, not exact-cwd-only, and project hooks load only when that repo or worktree anchor is trusted.

When an event matches, `pi-hooks` evaluates conditions and runs the configured actions. `bash` actions receive hook context JSON on stdin plus injected `PI_*` environment variables such as `PI_PROJECT_DIR`, `PI_WORKTREE_DIR`, `PI_SESSION_ID`, and `PI_GIT_COMMON_DIR`. At agent start, the extension also appends a short hook-awareness note to the system prompt so PI has the current hook and trust context while it works.

## Native PI surface

### Events

| Event | Meaning |
|---|---|
| `tool.before.*` | Before a tool call |
| `tool.after.*` | After a tool call |
| `file.changed` | Synthesized after recognized file mutations |
| `session.created` | PI startup or a genuinely new session |
| `session.idle` | Agent turn finished and no messages are pending |
| `session.deleted` | Session shutdown or switch, intentionally lossy |

### Actions

| Action | PI behavior |
|---|---|
| `bash` | Runs a shell command with injected context |
| `tool` | Sends a follow-up prompt into the current PI session |
| `notify` | Shows a PI notification when a UI surface exists |
| `confirm` | Shows a confirmation dialog before a tool runs |
| `setStatus` | Sets a PI status-bar entry keyed to the hook |

### Slash commands

| Command | What it shows |
|---|---|
| `/hooks-status` | Active hooks, config paths, trust state, and log path |
| `/hooks-validate` | Validation results for active hooks and skipped untrusted project hooks |
| `/hooks-trust` | Adds the current repo/worktree anchor to `~/.pi/agent/trusted-projects.json` |
| `/hooks-reload` | Reloads the extension and command surface |
| `/hooks-tail-log` | Log path plus a ready-to-run `tail -F` command |

`/hooks-status`, `/hooks-validate`, and hook-load validation errors also emit structured in-session diagnostics when PI supports custom messages.

## Important limitations

These are the PI-specific constraints that matter most:

- `command:` actions are unsupported on PI and are rejected at load time
- `tool:` is prompt injection, not imperative tool execution
- `action: stop` only has real effect on `tool.before.*`
- `runIn: main` is unsupported for non-`bash` actions
- `session.deleted` is intentionally lossy
- `user_bash` interception is opt-in with `PI_HOOKS_ENABLE_USER_BASH=1`

If you are authoring hooks, keep those rules in mind first. They explain most surprising behavior.

## Config paths and trust

Global root config paths:

1. `~/.pi/agent/hook/hooks.yaml`
2. `~/.pi/agent/hooks.yaml`

Project root config paths:

1. `<project>/.pi/hook/hooks.yaml`
2. `<project>/.pi/hooks.yaml`

Project hooks are gated by trust because they can run arbitrary `bash` with your user permissions. Trust is evaluated against the repo/worktree anchor, not an arbitrary nested directory string.

Two ways to trust a project:

```bash
PI_HOOKS_TRUST_PROJECT=1 pi
```

or use the built-in command:

```text
/hooks-trust
```

## Examples

Example workflows live under [`examples/`](./examples/). The main one today is [`examples/atomic-commit-snapshot-worker/`](./examples/atomic-commit-snapshot-worker/).

That snapshot worker is an opt-in example, not a built-in PI feature.

## Docs

If you want the full reference, start here:

- [`docs/README.md`](./docs/README.md) for the docs entry point and reading order
- [`docs/setup.md`](./docs/setup.md) for install, config paths, trust, reloads, and environment variables
- [`docs/hooks-reference.md`](./docs/hooks-reference.md) for the hook schema, events, conditions, actions, and PI behavior
- [`docs/agent-authoring-guide.md`](./docs/agent-authoring-guide.md) for practical authoring rules
- [`docs/debugging-hooks.md`](./docs/debugging-hooks.md) for logs and troubleshooting
- [`docs/examples/README.md`](./docs/examples/README.md) for copy-paste example patterns

## License

MIT.

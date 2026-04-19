# pi-hooks

Port of https://github.com/KristjanPikhof/OpenCode-Hooks to PI.

YAML-driven hooks for the [PI coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent). Run bash scripts on tool calls and session lifecycle events; block dangerous commands; surface notifications, confirmations, and status-bar entries from your hook config.

---

## Requirements

- **macOS or Linux.** Windows is unsupported (the bash executor expects a POSIX `bash` on `$PATH`).
- **Node.js ≥ 22.0.0.** Path conditions (`matchesAnyPath`, `matchesAllPaths`) use `node:path.matchesGlob`, which exists from Node 22.
- **`bash` on `$PATH`** (override with `PI_HOOKS_BASH_EXECUTABLE`).
- **`@mariozechner/pi-coding-agent ^0.67.0`** (peer dependency — installed alongside PI itself).

---

## Quick start

```bash
git clone https://github.com/KristjanPikhof/pi-hooks
cd pi-hooks
bun install      # or: npm install

# Make pi auto-discover the extension globally
ln -s "$PWD/src/index.ts" ~/.pi/agent/extensions/pi-hooks.ts

# Drop a minimal hooks.yaml so something happens
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/hooks.yaml <<'YAML'
hooks:
  - event: session.idle
    actions:
      - notify: "Agent is idle"
YAML

# Run pi as usual; on session idle a notification fires.
pi
# expect: [pi-hooks] Loaded 1 hook (global: 1, project: 0).
```

If a trusted project also has `.pi/hooks.yaml`, startup output looks like:

```text
[pi-hooks] Loaded 3 hooks (global: 1, project: 2).
```

### Alternative installation paths

| Method | When to use |
|--------|-------------|
| `ln -s "$PWD/src/index.ts" ~/.pi/agent/extensions/pi-hooks.ts` | **Recommended.** PI auto-discovers, hot-reloadable via `/reload`. |
| `pi -e /path/to/pi-hooks/src/index.ts` | One-off / testing without touching the global extensions dir. |
| Drop in `<project>/.pi/extensions/pi-hooks.ts` | Project-local install. |

---

## Examples (opt-in via `hooks.yaml`)

- [`examples/atomic-commit-snapshot-worker/`](./examples/atomic-commit-snapshot-worker/) — auto-commit every `write`/`edit` through a Python snapshot pipeline. Includes a ready-to-paste `hooks.yaml`.

---

## Configuration

### hooks.yaml locations

The extension resolves one global config and one project-level config.

**Global:**
1. `~/.pi/agent/hooks.yaml`
2. `%APPDATA%/pi/agent/hooks.yaml` (Windows only)

**Project-level** (resolved from `cwd` at first event, **only when the project is trusted** — see below):
1. `<project>/.pi/hooks.yaml`

Both files are loaded when both exist. The project file can override the global one.

On first load, pi-hooks prints a short summary so you can see what was picked up:

```text
[pi-hooks] Loaded 3 hooks (global: 1, project: 2).
```

### Project hook trust (security)

Project-scoped hook files contain `bash:` actions and run with your user's full permissions. To prevent a freshly cloned untrusted repo from executing arbitrary code the moment you `cd` in, **project hooks are only loaded for explicitly trusted directories**.

Two ways to trust a project:

1. **Per-session env var** — fast and ephemeral:
   ```bash
   PI_HOOKS_TRUST_PROJECT=1 pi
   ```
2. **Persistent trust list** — add the absolute project directory to `~/.pi/agent/trusted-projects.json`:
   ```json
   ["/Users/me/code/myproj", "/Users/me/code/another-proj"]
   ```

Untrusted project hook files trigger a one-time warning explaining how to opt in, and are then skipped. Global hooks (`~/.pi/agent/hooks.yaml`) are not gated — they're already in your home directory and under your direct control.

### Minimal example

```yaml
hooks:
  # Log every file the agent writes/edits.
  - event: file.changed
    actions:
      - bash: 'echo "[hook] changed: $(jq -r ".changes[].path" <<<"$(cat)")"'

  # Notify when the agent finishes a turn.
  - event: session.idle
    actions:
      - notify: "Agent is idle"
```

---

## Supported features

### Hook events

| Event | When it fires |
|-------|--------------|
| `tool.before.<name>` | Before any tool call; `*` matches all tools |
| `tool.before.*` | Before every tool call |
| `tool.after.<name>` | After any tool call |
| `tool.after.*` | After every tool call |
| `file.changed` | Synthesized from `write`/`edit` tool results |
| `session.idle` | When the agent loop ends and no messages are pending |
| `session.created` | On new session or PI startup |
| `session.deleted` | On session shutdown or session switch (lossy — see Unsupported) |

**PI built-in tool names:** `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`.

### Conditions

```yaml
conditions:
  - matchesCodeFiles          # matches source/config file extensions
  - matchesAnyPath:
      - "src/**/*.ts"
      - "*.json"
  - matchesAllPaths:
      - "src/**"
      - "**/*.ts"
```

### Actions

| Action | Behavior on PI |
|--------|---------------|
| `bash` | Spawns bash with injected env vars; exit code 2 on `tool.before.*` blocks the tool |
| `tool` | Sends a prompt to the current session via `pi.sendUserMessage`; cross-session targeting is advisory-only |
| `notify` | Shows a UI notification; `success` level maps to `info` |
| `confirm` | Shows a confirmation dialog; rejection blocks the tool on pre-tool hooks |
| `setStatus` | Sets a status-bar entry keyed to the hook ID |

**`bash` action — injected environment variables:**

| Variable | Alias | Value |
|----------|-------|-------|
| `PI_PROJECT_DIR` | `OPENCODE_PROJECT_DIR` | Current project directory |
| `PI_WORKTREE_DIR` | `OPENCODE_WORKTREE_DIR` | Git worktree root |
| `PI_SESSION_ID` | `OPENCODE_SESSION_ID` | Current session ID |
| `PI_GIT_COMMON_DIR` | `OPENCODE_GIT_COMMON_DIR` | Git common directory (worktrees) |

Both `PI_*` (canonical) and `OPENCODE_*` (legacy alias) names are always set so scripts migrated from OpenCode work unchanged.

The bash executable defaults to `bash`. Override with `PI_HOOKS_BASH_EXECUTABLE=/path/to/bash`.

A bash action on a `tool.before.*` hook that exits with code 2 blocks the tool call. Any non-zero exit that is not code 2 is treated as a failed hook but does not block.

Hook context JSON is written to stdin of the bash process.

### async queue serialization

```yaml
- event: tool.after.write
  async: true
  actions:
    - bash: ./commit.sh
```

Setting `async: true` enqueues the hook for serialized execution instead of running it inline.

### scope

```yaml
scope: main    # bash actions only — fires only in the root/main session
scope: child   # fires only in child sessions (filters via session ancestry)
scope: all     # default — fires in all sessions
```

`scope: main` is only supported for bash actions. Using it with other action types is a hard load error.

---

## Unsupported / compatibility notes

### `command:` actions — rejected at load time

PI exposes no API to invoke slash commands from event handlers. Hooks that contain a `command:` action are **dropped from the active hook map at load time** with a clear error logged to stderr — they will not execute. Replace with `bash:` or `tool:`.

```yaml
# This hook is dropped at load time with an error:
actions:
  - command: /my-command

# Replace with:
actions:
  - bash: pi --rpc my-command   # or whatever the bash equivalent is
```

### `session.deleted` is lossy

PI fires `session_shutdown` and `session_before_switch` for graceful shutdown, `/new`, `/resume`, and `/fork` — there is no way to distinguish them. `session.deleted` fires for all of these. Do not use it as a reliable "session was closed" signal.

### Tool names that never match

The following tool names from OpenCode have no PI equivalent and will never match:

- `multiedit`
- `patch`
- `apply_patch`

PI built-ins are: `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`. Hooks on `tool.before.multiedit` etc. are loaded with an advisory warning, not a hard error.

### `runIn: main` on non-bash actions — rejected at load time

`runIn: main` is only supported for `bash:` actions on PI. Hooks with `runIn: main` paired with a `tool:`, `notify:`, `confirm:`, or `setStatus:` action are dropped at load with an error.

### `tool:` action — advisory only

`tool:` actions run as current-session prompts via `pi.sendUserMessage`. Cross-session targeting is not supported. The action works but always targets the current session, regardless of `runIn`.

### `behavior: stop` — only for pre-tool hooks

PI does not expose an extension-side abort outside `tool_call`. `action: stop` on a `tool.before.*` hook reaches PI as a `block: true` response (the tool does not run). On `tool.after.*` or `session.idle`, abort is a no-op (logged when `PI_HOOKS_DEBUG=1`).

### `confirm:` fails closed in headless mode

If PI is running without a UI surface (print/RPC mode), `confirm:` actions return `false` (deny) instead of silently approving. This protects destructive operations behind a confirm gate from auto-running where no human can answer. Set `PI_HOOKS_CONFIRM_AUTO_APPROVE=1` to opt into the previous fail-open behavior.

---

## Examples

- [`examples/atomic-commit-snapshot-worker/`](./examples/atomic-commit-snapshot-worker/) — Python-based atomic-commit pipeline. Wire it up via `hooks.yaml`; see the example's README for setup, env vars, and verification.

---

## Troubleshooting

**First failure — work through this list:**

1. Confirm Node version: `node --version` → must be ≥ 22.0.0. Older Node disables path-conditioned hooks silently (now hard-fails at startup with an error in the latest version).
2. Confirm `bash` is on `$PATH`: `which bash`. Override with `PI_HOOKS_BASH_EXECUTABLE=/path/to/bash`.
3. Run with debug logging: `PI_HOOKS_DEBUG=1 pi`. Look for `[pi-hooks]` lines on stderr.
4. Confirm the extension is loaded: a debug build shows `[pi-hooks] registered …` on startup.
5. If a project hook isn't firing, check the trust gate: `cat ~/.pi/agent/trusted-projects.json` and confirm the project path is listed (or use `PI_HOOKS_TRUST_PROJECT=1`).
6. If a `notify:` / `confirm:` / `setStatus:` action does nothing, PI is in headless mode (`ctx.hasUI === false`). Bash actions still run.

**Windows:** Unsupported. The extension logs one warning and registers no handlers (the bash executor requires a POSIX `bash`).

**Debug logging:**
```bash
PI_HOOKS_DEBUG=1 pi
```
Logs `[pi-hooks] …` lines to stderr for event dispatch, block decisions, abort no-ops, UI surface warnings, and Python-bridge failures (when an example pipes into Python).

**Override the bash executable:**
```bash
PI_HOOKS_BASH_EXECUTABLE=/opt/homebrew/bin/bash
```

**Override the bash output cap (default 1 MiB per hook):**
```bash
PI_HOOKS_MAX_OUTPUT_BYTES=4194304
```

**GUI-launched PI inherits a different environment.** When you launch PI from a terminal, hooks see your shell's `$PATH`, `OPENAI_API_KEY`, etc. When PI launches from Spotlight / the Dock / an IDE extension on macOS, it inherits `launchd`'s environment instead — your `~/.zshrc` exports do **not** reach hooks. Either launch PI from a terminal, wrap the hook command in `/bin/zsh -ilc "..."`, or `launchctl setenv KEY value` for system-wide propagation.

**No UI surface:** If `notify`, `confirm`, or `setStatus` actions are silently skipped, PI is running in print/RPC mode where `ctx.hasUI` is false. `notify` and `setStatus` no-op (one warning per process lifetime). `confirm` fails *closed* (returns `false`) — set `PI_HOOKS_CONFIRM_AUTO_APPROVE=1` to keep the old auto-approve behavior. Bash actions always run.

---

## Migration from OpenCode

Existing `~/.config/opencode/hook/hooks.yaml` continues to work as a fallback with no changes required.

**What carries over unchanged:**
- All hook events: `tool.before.*`, `tool.after.*`, `file.changed`, `session.*`
- Conditions: `matchesCodeFiles`, `matchesAnyPath`, `matchesAllPaths`
- Bash actions, including the snapshot-hook bash invocations
- `scope`, `async`, `runIn: current`

**Env var changes:** `PI_*` names are now canonical. `OPENCODE_*` names are kept as aliases and are always injected alongside `PI_*`, so existing bash scripts work unchanged.

**Things to rewrite:**

| Was | Replace with |
|-----|-------------|
| `command:` actions | `bash:` or `tool:` |
| `runIn: main` on non-bash actions | `bash:` equivalent or remove `runIn` |
| `tool.before.multiedit` / `patch` / `apply_patch` events | `tool.before.edit` or `tool.before.write` |

**New in PI:** `notify:`, `confirm:`, `setStatus:` actions wired to `ctx.ui`. `/snapshot-status`, `/snapshot-flush` slash commands. Live queue-depth status widget.

---

## License

MIT.

Source: https://github.com/KristjanPikhof/OpenCode-Hooks

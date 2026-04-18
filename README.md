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
```

To verify it loaded, run pi with debug logging:

```bash
PI_HOOKS_DEBUG=1 pi
# expect lines starting with "[pi-hooks]" on stderr
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

The extension resolves one global config and one project-level config. Resolution order (first existing file wins within each tier):

**Global:**
1. `~/.pi/agent/hooks.yaml` (PI-native, preferred)
2. `%APPDATA%/pi/agent/hooks.yaml` (Windows only)
3. `~/.config/opencode/hook/hooks.yaml` (OpenCode fallback)
4. `%APPDATA%/opencode/hook/hooks.yaml` (Windows OpenCode fallback)

**Project-level** (resolved from `cwd` at first event, **only when the project is trusted** — see below):
1. `<project>/.pi/hooks.yaml` (PI-native, preferred)
2. `<project>/.opencode/hook/hooks.yaml` (OpenCode fallback)

Both files are loaded when both exist. The project file can override the global one.

A first-load warning fires when a legacy OpenCode path is being used so you remember to migrate to the PI-native paths.

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

**Windows:** Unsupported. The extension logs one warning and registers no handlers (bash actions require a POSIX bash on PATH).

**TypeScript-side debug logging:**
```bash
PI_HOOKS_DEBUG=1 pi -e ./src/index.ts
```
Logs `[pi-hooks] …` lines to stderr for event dispatch, block decisions, and UI surface warnings.

**Override the bash executable:**
```bash
PI_HOOKS_BASH_EXECUTABLE=/opt/homebrew/bin/bash
```

**No UI surface:** If `notify`, `confirm`, or `setStatus` actions are silently skipped, PI is running in print/RPC mode where `ctx.hasUI` is false. These actions are no-ops in that mode (one warning per process lifetime is logged). Bash actions still run.

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

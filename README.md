# pi-hooks

Port of https://github.com/KristjanPikhof/OpenCode-Hooks to PI.

YAML-driven hooks for the [PI coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent). Run bash scripts on tool calls and session lifecycle events; block dangerous commands; surface notifications, confirmations, and status-bar entries from your hook config.

---

## Requirements

- **macOS or Linux.** Windows is unsupported (the bash executor expects a POSIX `bash` on `$PATH`).
- **Node.js ≥ 22.0.0.** Path conditions (`matchesAnyPath`, `matchesAllPaths`) use `node:path.matchesGlob`, which exists from Node 22.
- **`bash` on `$PATH`** (override with `PI_HOOKS_BASH_EXECUTABLE`).
- **`@mariozechner/pi-coding-agent ^0.68.1`** (peer dependency — installed alongside PI itself).

---

## Quick start

```bash
git clone https://github.com/KristjanPikhof/pi-hooks
cd pi-hooks
bun install      # or: npm install

# Make pi auto-discover the extension globally
ln -s "$PWD/src/index.ts" ~/.pi/agent/extensions/pi-hooks.ts

# Drop a minimal hooks.yaml so something happens
mkdir -p ~/.pi/agent/hook
cat > ~/.pi/agent/hook/hooks.yaml <<'YAML'
hooks:
  - event: session.idle
    actions:
      - notify: "Agent is idle"
YAML

# Run pi as usual; on session idle a notification fires.
pi
# expect: [pi-hooks] Loaded 1 hook (global: 1, project: 0).
```

If a trusted project also has `.pi/hook/hooks.yaml` (or `.pi/hooks.yaml`), startup output looks like:

```text
[pi-hooks] Loaded 3 hooks (global: 1, project: 2).
```

### Alternative installation paths

| Method | When to use |
|--------|-------------|
| `ln -s "$PWD/src/index.ts" ~/.pi/agent/extensions/pi-hooks.ts` | **Recommended.** PI auto-discovers, hot-reloadable via `/reload`. |
| `pi -e /path/to/pi-hooks/src/index.ts` | One-off / testing without touching the global extensions dir. |
| Drop in `<project>/.pi/extensions/pi-hooks.ts` | Project-local install. |

Editing a discovered `hooks.yaml` is picked up on the next relevant PI event; if a reload fails, `pi-hooks` keeps the last known good hook set and logs the error.

---

## Examples (opt-in via `hooks.yaml`)

- [`examples/atomic-commit-snapshot-worker/`](./examples/atomic-commit-snapshot-worker/) — auto-commit every `write`/`edit` through a Python snapshot pipeline. Includes a ready-to-paste `hooks.yaml`.

## Detailed docs

- [`docs/README.md`](./docs/README.md) — documentation entry point
- [`docs/setup.md`](./docs/setup.md) — installation, config paths, trust, reloads
- [`docs/hooks-reference.md`](./docs/hooks-reference.md) — exact hook fields, events, conditions, actions, and PI-specific behavior
- [`docs/agent-authoring-guide.md`](./docs/agent-authoring-guide.md) — practical rules for people and agents writing `hooks.yaml`
- [`docs/debugging-hooks.md`](./docs/debugging-hooks.md) — persistent hook logs, tailing, and debugging workflow
- [`docs/examples/`](./docs/examples/) — copy-paste examples for each major hook pattern

---

## Pi 0.68.1 compatibility update

- `pi-hooks` now targets the Pi 0.68.1 extension surface and declares `@mariozechner/pi-coding-agent ^0.68.1` as its peer dependency.
- The supported native surfaces are the current tool and session lifecycle events, `pi.sendUserMessage`, and `ctx.ui.notify` / `ctx.ui.confirm` / `ctx.ui.setStatus`.
- Known PI limitations remain explicit: `command:` actions are still rejected, non-bash cross-session targeting is still unavailable, and `behavior: stop` only blocks pre-tool hooks.
- This release also tightens default failure reporting so hook delivery and adapter dispatch problems are visible without requiring debug mode.

---

## Configuration

### hooks.yaml locations

The extension resolves one global config and one project-level config.

**Global:**
1. `~/.pi/agent/hook/hooks.yaml` (preferred)
2. `~/.pi/agent/hooks.yaml`
3. `%APPDATA%/pi/agent/hook/hooks.yaml` (Windows only, preferred)
4. `%APPDATA%/pi/agent/hooks.yaml` (Windows only)

**Project-level** (resolved from `cwd` at first event, **only when the project is trusted** — see below):
1. `<project>/.pi/hook/hooks.yaml` (preferred)
2. `<project>/.pi/hooks.yaml`

One global config and one project config are loaded at most. Within each scope, the first existing path wins. Both files stay active unless the later file explicitly replaces or disables earlier hooks by `id` with `override:` / `disable:`.

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

Untrusted project hook files trigger a one-time warning explaining how to opt in, and are then skipped. Global hooks (`~/.pi/agent/hook/hooks.yaml` or `~/.pi/agent/hooks.yaml`) are not gated — they're already in your home directory and under your direct control.

### Minimal example

```yaml
hooks:
  # Log every synthesized file.changed payload for later inspection.
  - event: file.changed
    actions:
      - bash: 'mkdir -p .pi-hook-logs && cat >> .pi-hook-logs/file-changed.ndjson'

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
| `file.changed` | Synthesized from recognized mutation tool results; on stock PI that includes `write`, `edit`, and some `bash` commands such as `mv`, `rm`, `touch`, and `mkdir` |
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
  - matchesAllPaths: "src/**"
  - matchesAllPaths: "**/*.ts"
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
scope: main    # fires only in the root/main session
scope: child   # fires only in child sessions (filters via session ancestry)
scope: all     # default — fires in all sessions
```

`scope` filters where the hook itself runs. This is separate from `runIn`, which is compatibility metadata for action targeting.

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

Hooks with `runIn: main` paired with a `tool:`, `notify:`, `confirm:`, or `setStatus:` action are dropped at load with an error.

`runIn` is compatibility metadata, not a strong cross-session execution guarantee on PI. For the exact current behavior, see [`docs/hooks-reference.md`](./docs/hooks-reference.md).

### `tool:` action — advisory only

For valid PI configurations, `tool:` actions run as current-session follow-up prompts via `pi.sendUserMessage`. If a different target session is ever requested, the adapter degrades to the current session and records that mismatch in logs.

If `pi.sendUserMessage` fails, the hook now reports a normal error to stderr by default. `PI_HOOKS_DEBUG=1` is only needed for deeper trace-level diagnostics.

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
3. Start PI and look for the startup summary: `[pi-hooks] Loaded N hooks (global: G, project: P).`
4. If you need deeper diagnostics, run with debug logging: `PI_HOOKS_DEBUG=1 pi`.
5. If a project hook isn't firing, check the trust gate: `cat ~/.pi/agent/trusted-projects.json` and confirm the project path is listed (or use `PI_HOOKS_TRUST_PROJECT=1`).
6. If a `notify:` / `confirm:` / `setStatus:` action is degraded, PI is in headless mode (`ctx.hasUI === false`). `notify` and `setStatus` warn once per adapter/runtime instance; `confirm` fails closed. Bash actions still run.

**Windows:** Unsupported. The extension logs one warning and registers no handlers (the bash executor requires a POSIX `bash`).

**Timed-out bash hooks on macOS/Linux:** `pi-hooks` now signals the whole spawned process group, not just the top-level shell, so backgrounded descendants are cleaned up as part of timeout handling. Timeout logs include the SIGTERM/SIGKILL cleanup path and final result.

**Debug logging:**
```bash
PI_HOOKS_DEBUG=1 pi
```
Normal hook execution failures and adapter dispatch failures already print concise stderr errors without debug mode. Debug logging adds persistent structured traces.

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

**No UI surface:** If `notify`, `confirm`, or `setStatus` actions do not reach the PI UI, PI is running in print/RPC mode where `ctx.hasUI` is false. `notify` and `setStatus` degrade to a warned no-op (one warning per adapter/runtime instance), while structured logs record that degraded outcome when logging is enabled. `confirm` fails *closed* (returns `false`) — set `PI_HOOKS_CONFIRM_AUTO_APPROVE=1` to keep the old auto-approve behavior. Bash actions always run.

---

## Migration from OpenCode

OpenCode hook paths are no longer discovered automatically. Move your config to the PI-native locations instead:

- global: `~/.pi/agent/hook/hooks.yaml` or `~/.pi/agent/hooks.yaml`
- project: `<project>/.pi/hook/hooks.yaml` or `<project>/.pi/hooks.yaml`

If both PI-native variants exist in the same scope, the `hook/hooks.yaml` location wins.

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

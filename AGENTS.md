# AGENTS.md

This file is the short version of what matters most when editing `pi-hooks`.

## What is actually built in

Native PI-facing features on this branch:

- hook events: `tool.before.*`, `tool.after.*`, `file.changed`, `session.created`, `session.idle`, `session.deleted`
- actions: `bash`, `tool`, `notify`, `confirm`, `setStatus`
- slash commands: `/hooks-status`, `/hooks-validate`, `/hooks-trust`, `/hooks-reload`, `/hooks-tail-log`
- structured in-session diagnostics via custom messages
- before-agent-start hook-awareness prompt injection
- opt-in `user_bash` interception through `tool.before.bash`

Example-only, not built-in product features:

- the atomic commit snapshot worker
- any `/snapshot-*` workflow

## Important limitations

- `command:` actions are unsupported on PI and are rejected at load time
- `tool:` actions are prompt injection, not imperative tool execution
- non-bash `runIn: main` is unsupported
- `action: stop` only has real effect on `tool.before.*`
- `session.deleted` is intentionally lossy
- `user_bash` interception is opt-in via `PI_HOOKS_ENABLE_USER_BASH=1`

## Trust and discovery model

- one global root config and one project root config are discovered
- each root may import more hook files via top-level `imports:`
- project discovery is repo/worktree-aware, not exact-cwd-only
- trust is evaluated against the repo/worktree anchor, not an arbitrary nested path string

## Documentation rules

- keep built-in features separate from examples
- use `action: stop`, not `behavior: stop`
- if a feature is opt-in, say so explicitly
- if docs mention trust, be clear whether they mean cwd, project root, or repo/worktree anchor

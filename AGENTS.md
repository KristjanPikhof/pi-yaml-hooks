# AGENTS.md

This is the short contract for agents editing `pi-hooks`. Keep it compact:
facts that prevent wrong implementation or misleading docs belong here; broad
tutorial content belongs in `docs/`.

## Product surface

Built-in PI-facing features:

- events: `tool.before.*`, `tool.after.*`, `file.changed`,
  `session.created`, `session.idle`, `session.deleted`
- actions: `bash`, `tool`, `notify`, `confirm`, `setStatus`
- commands: `/hooks-status`, `/hooks-validate`, `/hooks-trust`,
  `/hooks-reload`, `/hooks-tail-log`
- structured diagnostics via custom PI messages
- hook-awareness prompt injection before agent start
- opt-in `user_bash` interception through `tool.before.bash`

Path conditions:

- `matchesCodeFiles` works when an event has file context
- `matchesAnyPath` and `matchesAllPaths` are supported on `file.changed`,
  `session.idle`, and `tool.after.*`
- non-mutating tool events usually have no paths, so path filters do not match

Example-only, not built-in product features:

- the atomic commit snapshot worker
- any `/snapshot-*` workflow
- developer guard and feedback packs under `examples/`

## PI-specific limits

- `command:` actions are unsupported on PI and are rejected at load time
- `tool:` actions are prompt injection, not imperative tool execution
- `runIn: main` is rejected for non-`bash` actions
- do not rely on `runIn: main` to change bash process/session context
- prefer `scope` for real main-vs-child routing decisions
- `action: stop` only has real effect on `tool.before.*`
- `session.deleted` is intentionally lossy
- `user_bash` interception is opt-in via `PI_HOOKS_ENABLE_USER_BASH=1`

## Config, imports, and trust

- discover at most one global root config and one project root config
- each root may import more hook files with top-level `imports:`
- project discovery is repo/worktree-aware, not exact-cwd-only
- trust is evaluated against the repo/worktree anchor, not an arbitrary nested path string
- project hooks are ignored until that anchor is trusted

## Documentation rules

- keep built-in features separate from examples
- use `action: stop`, not `behavior: stop`
- if a feature is opt-in, say so explicitly
- if docs mention trust, be clear whether they mean cwd, project root, or repo/worktree anchor
- when documenting `tool:`, state that PI receives a follow-up prompt
- when documenting examples, say they are copyable patterns, not product features

## Verification expectations

- run `npm run typecheck` after TypeScript changes
- run `npm run build` before executing compiled test files from `dist/`
- use focused tests for the touched surface; `npm test` may need script fixes

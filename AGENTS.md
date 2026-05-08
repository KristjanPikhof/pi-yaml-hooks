# AGENTS.md

Compact contract for agents editing `pi-yaml-hooks`. Facts that prevent wrong implementation or misleading docs only. Tutorials live in `docs/`.

## SDK peer

- Peer scope: `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` `^0.74.0`
- Scope migrated from `@mariozechner/*` in 0.74.0; never reintroduce old scope in `src/`, `package.json`, `scripts/`, or new docs
- Node `>=22.0.0`; macOS/Linux only (Windows guarded in `src/pi/adapter.ts`)

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | PI extension entry; default export wires adapter + commands + autocomplete + diagnostics + prompt |
| `src/core/` | Host-agnostic runtime: load-hooks, runtime dispatch, bash executor, types, logger |
| `src/pi/` | PI adapter glue; one file per surface (`adapter`, `commands`, `autocomplete`, `diagnostics`, `prompt-support`, `user-bash`, `session-lineage`, `unsupported`) |
| `extensions/index.ts` | Symlink target for local-dev installs (`pi -e` / `~/.pi/agent/extensions/...`) |
| `examples/` | Copyable patterns only — atomic commit snapshot worker, dev guards/feedback packs. Not product features |
| `scripts/check-sdk-matrix.sh` | SDK compat runner; `compat:sdk-matrix[:dry-run\|:future]` npm scripts |
| `scripts/smoke/pi-runtime-smoke.sh` | Runtime smoke checklist for surfaces tests cannot emulate |
| `dist/` | Build output; emitted by `tsc` then a tiny extensions re-export shim |

## Product surface

Built-ins:

- Events: `tool.before.*`, `tool.after.*`, `file.changed`, `session.created`, `session.idle`, `session.deleted`
- Actions: `bash`, `tool`, `notify`, `confirm`, `setStatus`
- Slash commands: `/hooks-status`, `/hooks-validate`, `/hooks-trust`, `/hooks-reload`, `/hooks-tail-log`
- Structured diagnostics via PI custom messages
- Hook-awareness prompt injection before agent start
- Opt-in `user_bash` interception via `tool.before.bash`

Path conditions (`src/core/types.ts`):

- `matchesCodeFiles` — legacy, single-file events
- `matchesAnyPath` / `matchesAllPaths` — supported on `file.changed`, `session.idle`, `tool.after.*`
- Non-mutating tool events have no paths; path filters do not match there

Examples-only (not product):

- `examples/atomic-commit-snapshot-worker/`
- `/snapshot-*` workflows
- `examples/post-tool-developer-feedback/`, `examples/pre-tool-developer-guards/`

## PI-specific limits

- `command:` actions rejected at load time
- `tool:` is prompt injection, not imperative tool execution
- `runIn: main` rejected for non-`bash` actions; do not rely on it to change bash process/session context
- Prefer `scope` for real main-vs-child routing
- `action: stop` only effective on `tool.before.*`
- `session.deleted` is intentionally lossy (fires on shutdown + session switches like `/new`, `/resume`, `/fork`)
- `user_bash` interception opt-in via `PI_YAML_HOOKS_ENABLE_USER_BASH=1`

## Config, imports, trust

- At most one global root config + one project root config
- Each root may import more files via top-level `imports:`
- Project discovery is repo/worktree-aware, not exact-cwd-only
- Trust evaluated against repo/worktree anchor, not arbitrary nested path
- Project hooks ignored until anchor trusted
- Trust shortcuts: `/hooks-trust`, or `PI_YAML_HOOKS_TRUST_PROJECT=1`

## Environment variables

| Var | Effect |
|---|---|
| `PI_YAML_HOOKS_ENABLE_USER_BASH` | `=1` enables `user_bash` interception |
| `PI_YAML_HOOKS_TRUST_PROJECT` | `=1` trusts the current project for the session |
| `PI_YAML_HOOKS_PROMPT_AWARENESS` | `=0` disables hook-awareness prompt injection |
| `PI_YAML_HOOKS_BASH_EXECUTABLE` | Override bash path (default `bash`) |
| `PI_YAML_HOOKS_MAX_OUTPUT_BYTES` | Bash stdout/stderr cap (default 1 MiB) |
| `PI_YAML_HOOKS_MAX_STDIN_BYTES` | Bash stdin context cap (default 256 KiB) |
| `PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE` | Auto-accept `confirm:` prompts (testing only) |
| `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS` | Permit imports from outside config root |
| `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS` | Permit npm-package imports |
| `PI_YAML_HOOKS_DEBUG` | `=1` verbose logging |
| `PI_YAML_HOOKS_LOG_LEVEL` | `debug\|info\|warn\|error` |
| `PI_YAML_HOOKS_LOG_FILE` | Override log file path |
| `PI_YAML_HOOKS_LOG_STDERR` | `=1` mirror logs to stderr |

## Documentation rules

- Built-in features ≠ examples; never blur them
- Use `action: stop`, not `behavior: stop`
- Mark opt-in features explicitly
- When mentioning trust, name the anchor (cwd / project root / repo or worktree anchor)
- `tool:` documentation must say PI receives a follow-up prompt
- Examples are copyable patterns, not product features

## Lockfile

- `package-lock.json` is canonical; `bun.lock` not committed
- `npm install` to update deps
- A fresh install resolves `@earendil-works/*` 0.74.0; do not pin to old `@mariozechner/*`

## Verification

| Command | Use |
|---|---|
| `npm run typecheck` | After any TS change |
| `npm run build` | Before running compiled tests in `dist/` |
| `npm run test:internal` | Full dev suite (builds first, runs `dist/**/*.test.js`); known flake: `timed out bash hooks kill descendant background processes on POSIX` |
| `npm run compat:sdk-matrix` | SDK peer-range check in temp clone; does not mutate working tree |
| `npm run compat:sdk-matrix:dry-run` | Print plan, no installs |
| `npm run compat:sdk-matrix:future` | Advisory check against next minor (e.g. `0.75.x`); passing it does not widen `peerDependencies` |
| `scripts/smoke/pi-runtime-smoke.sh` | Manual runtime smoke; record evidence with SDK-widening PRs |

`npm test` is a no-op for consumers (`echo "no consumer tests" && exit 0`); always use `test:internal` when validating.

## Workflow quirks

- An atomic-commit hook auto-commits each Edit/Write tool call. Do not stage manually mid-task; expect a commit per edit
- `scripts/tail-hook-log.sh` tails the active log file (referenced by `/hooks-tail-log`)
- `prepack` runs `build:publish` (clean rebuild via `tsconfig.publish.json`) before `npm publish`

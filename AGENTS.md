# AGENTS.md

Contract for agents editing `pi-yaml-hooks`. Facts only; tutorials in `docs/`.

## SDK peer

- `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` `^0.74.0`
- Migrated from `@mariozechner/*` at 0.74.0; never reintroduce old scope
- Node `>=22.0.0`; macOS/Linux only (Windows guarded in `src/pi/adapter.ts`)

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | PI entry; default export wires adapter + commands + autocomplete + diagnostics + prompt |
| `src/core/` | Host-agnostic: load-hooks, runtime, bash-executor, types, logger |
| `src/pi/` | PI glue: `adapter`, `commands`, `autocomplete`, `diagnostics`, `prompt-support`, `user-bash`, `session-lineage`, `unsupported` |
| `extensions/index.ts` | Symlink target for local-dev installs |
| `examples/` | Copyable patterns only — not product features |
| `scripts/check-sdk-matrix.sh` | SDK compat runner |
| `scripts/smoke/pi-runtime-smoke.sh` | Manual runtime smoke |
| `dist/` | Build output |

## Surface

Built-ins:

- Events: `tool.before.*`, `tool.after.*`, `file.changed`, `session.{created,idle,deleted}`
- Actions: `bash`, `tool`, `notify`, `confirm`, `setStatus`
- Commands: `/hooks-{status,validate,trust,reload,tail-log}`
- Structured diagnostics via PI custom messages
- Hook-awareness prompt injection before agent start
- Opt-in `user_bash` interception via `tool.before.bash`

Path conditions (`src/core/types.ts`):

- `matchesCodeFiles` — legacy, single-file events
- `matchesAnyPath` / `matchesAllPaths` — only on `file.changed`, `session.idle`, `tool.after.*`
- Non-mutating tool events have no paths → path filters never match

Examples-only (not product): `examples/atomic-commit-snapshot-worker/`, `/snapshot-*`, `examples/post-tool-developer-feedback/`, `examples/pre-tool-developer-guards/`.

## PI limits

- `command:` actions rejected at load
- `tool:` injects a follow-up prompt, not imperative execution
- `runIn: main` rejected for non-`bash`; does not change bash process/session context
- Prefer `scope` for main-vs-child routing
- `action: stop` only effective on `tool.before.*`
- `session.deleted` lossy (shutdown + `/new`, `/resume`, `/fork`)
- `user_bash` opt-in via `PI_YAML_HOOKS_ENABLE_USER_BASH=1`

## Config + trust

- One global root + one project root; each may `imports:` more
- Project discovery repo/worktree-aware, not exact-cwd
- Trust against repo/worktree anchor; project hooks ignored until trusted
- Shortcuts: `/hooks-trust` or `PI_YAML_HOOKS_TRUST_PROJECT=1`

## Env vars

| Var | Effect |
|---|---|
| `PI_YAML_HOOKS_ENABLE_USER_BASH` | `=1` enable `user_bash` |
| `PI_YAML_HOOKS_TRUST_PROJECT` | `=1` trust current project |
| `PI_YAML_HOOKS_PROMPT_AWARENESS` | `=0` disable prompt injection |
| `PI_YAML_HOOKS_BASH_EXECUTABLE` | Override bash path |
| `PI_YAML_HOOKS_MAX_OUTPUT_BYTES` | Bash out cap (def 1 MiB) |
| `PI_YAML_HOOKS_MAX_STDIN_BYTES` | Bash stdin cap (def 256 KiB) |
| `PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE` | Auto-accept `confirm:` (testing) |
| `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS` | Allow imports outside config root |
| `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS` | Allow npm-package imports |
| `PI_YAML_HOOKS_DEBUG` | `=1` verbose |
| `PI_YAML_HOOKS_LOG_LEVEL` | `debug\|info\|warn\|error` |
| `PI_YAML_HOOKS_LOG_FILE` | Override log path |
| `PI_YAML_HOOKS_LOG_STDERR` | `=1` mirror to stderr |

## Doc rules

- Built-ins ≠ examples; never blur
- `action: stop`, not `behavior: stop`
- Mark opt-in features explicitly
- Name the trust anchor (cwd / project root / repo-worktree anchor)
- `tool:` doc must say PI receives a follow-up prompt

## Lockfile

`package-lock.json` canonical; no `bun.lock`. `npm install` to update.

## Verification

| Command | Use |
|---|---|
| `npm run typecheck` | After any TS change |
| `npm run build` | Before running `dist/**/*.test.js` |
| `npm run test:internal` | Full dev suite (builds first); known flake: `timed out bash hooks kill descendant background processes on POSIX` |
| `npm run compat:sdk-matrix[:dry-run]` | Peer-range check in temp clone |
| `npm run compat:sdk-matrix:future` | Advisory next-minor probe; does not widen peer |
| `scripts/smoke/pi-runtime-smoke.sh` | Runtime smoke; keep evidence on SDK-widening PRs |

`npm test` is a consumer no-op; use `test:internal` for validation.

## Quirks

- Atomic-commit hook auto-commits per Edit/Write; expect one commit per edit
- `prepack` runs `build:publish` (clean rebuild via `tsconfig.publish.json`)
- `scripts/tail-hook-log.sh` backs `/hooks-tail-log`

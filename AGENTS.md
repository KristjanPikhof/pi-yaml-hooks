# AGENTS.md

Contract for agents editing `pi-yaml-hooks`. Facts only; tutorials in `docs/`.

## SDK peer

- `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` `^0.74.0`. Never reintroduce `@mariozechner/*`.
- Node `>=22.0.0`; macOS/Linux only (win32 guarded in `src/pi/register-adapter.ts`).

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | PI default export; wires adapter + commands + autocomplete + diagnostics + prompt |
| `src/core/` | Host-agnostic. `runtime.ts`/`load-hooks.ts` hold state; impl in subdirs |
| `src/core/hooks/` | `yaml-envelope`, `schema`, `composition`, `imports`, `snapshot-cache` |
| `src/core/runtime/` | `dispatch`, `actions`, `async-queue`, `recursion-guard`, `path-filter` |
| `src/pi/` | `adapter` (compat barrel), `host-adapter`, `register-adapter`, `session-lifecycle`, `runtime-registry`, `event-mappers`, `commands`, `autocomplete`, `diagnostics`, `prompt-support`, `user-bash`, `session-lineage`, `unsupported` |
| `extensions/index.ts` | Symlink target for local-dev installs |
| `examples/` | Copyable patterns; not product |
| `scripts/run-tests.mjs` | Walks `dist/**/*.test.js`; spawns each sequentially under `node --test` |
| `scripts/check-sdk-matrix.sh` | SDK compat runner |
| `scripts/smoke/pi-runtime-smoke.sh` | Manual runtime smoke |
| `dist/` | Build output |

## Public surface

- Runtime: `pi-yaml-hooks` (default = PI extension).
- Type-only: `pi-yaml-hooks/types` re-exports `HookConfig`, `HookEvent`, `BashHookContext`, `SessionDeletedReason`. No runtime resolver. Smoke at `src/public-types-smoke.test.ts`.

## Built-ins

- Events: `tool.before.*`, `tool.after.*`, `file.changed`, `session.{created,idle,deleted}`
- Actions: `bash`, `tool`, `notify`, `confirm`, `setStatus`
- Commands: `/hooks-{status,validate,trust,reload,tail-log}`
- Structured diagnostics via PI custom messages; hook-awareness prompt injection at agent start; opt-in `user_bash` via `tool.before.bash`

Path conditions (`src/core/types.ts`):
- `matchesCodeFiles` — legacy, single-file events
- `matchesAnyPath` / `matchesAllPaths` — only on `file.changed`, `session.idle`, `tool.after.*`
- Non-mutating tool events have no paths → path filters never match

Examples-only (not product): `examples/atomic-commit-snapshot-worker/`, `/snapshot-*`, `examples/post-tool-developer-feedback/`, `examples/pre-tool-developer-guards/`.

## PI limits

- `command:` actions rejected at load
- `tool:` injects a follow-up prompt, not imperative execution
- `runIn: main` rejected for non-`bash`; doesn't change bash process/session context
- Prefer `scope` for main-vs-child routing
- `action: stop` only effective on `tool.before.*`. `async: true` + `action: stop` rejected at parse time; runtime warns once per source per runtime instance as safety net
- `session.deleted` envelope carries `reason` ∈ `quit|reload|new|resume|fork`
- `user_bash` opt-in via `PI_YAML_HOOKS_ENABLE_USER_BASH=1`
- `tool_args` redacted via `sanitizeToolArgsForSerialization` before bash stdin (`src/core/runtime/actions.ts`)

## Config + trust

- One global root + one project root; each may `imports:` more
- Project discovery repo/worktree-aware, not exact-cwd
- Trust against repo/worktree anchor; project hooks ignored until trusted
- Project imports must canonicalize inside anchor; bypass via `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1`
- Shortcuts: `/hooks-trust` or `PI_YAML_HOOKS_TRUST_PROJECT=1`

## Caps

YAML 1 MiB · import/canonicalize depth 32 · snapshot LRU 16 · runtime registry per-cwd LRU 8 · recursion-guard depth 32 · per-pattern glob LRU 256 · pending tool-calls 1000 (TTL 5 min, FIFO) · `tool_args` 64 KiB · session lineage cache 64 / depth 64 / header 64 KB

## Host abstraction

`HookPolicy` (`src/core/types.ts`) plugs host-specific diagnostics into the loader. Core ships `NOOP_POLICY`; `src/pi/unsupported.ts` registers the PI policy via `setActiveHookPolicy`. Never import `src/pi/*` from `src/core/*`.

## Env vars

Canonical: [`docs/setup.md#environment-variables`](docs/setup.md#environment-variables). Do not duplicate.

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
| `npm run test:internal` | Builds, then `node scripts/run-tests.mjs`. Known flake: `timed out bash hooks kill descendant background processes on POSIX` |
| `npm run compat:sdk-matrix[:dry-run]` | Peer-range check in temp clone |
| `npm run compat:sdk-matrix:future` | Advisory next-minor probe; doesn't widen peer |
| `scripts/smoke/pi-runtime-smoke.sh` | Runtime smoke; keep evidence on SDK-widening PRs |

`npm test` is a consumer no-op; use `test:internal`.

## Quirks

- Atomic-commit hook auto-commits per Edit/Write; one commit per edit
- `prepack` runs `build:publish` (clean rebuild via `tsconfig.publish.json`)
- `scripts/tail-hook-log.sh` backs `/hooks-tail-log`
- `load-hooks.ts` + `pi/adapter.ts` are re-export barrels; impl in `core/hooks/` and `pi/{host-adapter,register-adapter,session-lifecycle,runtime-registry,event-mappers}.ts`. `runtime.ts` is factory + per-runtime state; dispatch lives in `core/runtime/`.

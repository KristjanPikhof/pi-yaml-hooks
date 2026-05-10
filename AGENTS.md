# AGENTS.md

Contract for agents editing `pi-yaml-hooks`. Facts only; tutorials in `docs/`.

## SDK peer

- `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` `^0.74.0`
- Never reintroduce `@mariozechner/*` (pre-0.74 scope)
- Node `>=22.0.0`; macOS/Linux only (win32 guarded in `src/pi/register-adapter.ts`)

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | PI default export; wires adapter + commands + autocomplete + diagnostics + prompt |
| `src/core/` | Host-agnostic; `runtime.ts` and `load-hooks.ts` own state, real impl lives in subdirs |
| `src/core/hooks/` | `yaml-envelope` (1 MiB cap), `schema`, `composition` (id index, overrides, policy), `imports` (cycle, depth, trust-anchor), `snapshot-cache` (LRU 16, stat fingerprint) |
| `src/core/runtime/` | `dispatch`, `actions` (table-keyed), `async-queue`, `recursion-guard` (depth 32), `path-filter` (per-pattern LRU 256) |
| `src/pi/` | `adapter` (compat barrel) + `host-adapter`, `register-adapter`, `session-lifecycle`, `runtime-registry` (per-cwd LRU 8 + in-flight dedup), `event-mappers` (pure), `commands`, `autocomplete`, `diagnostics`, `prompt-support`, `user-bash`, `session-lineage`, `unsupported` |
| `extensions/index.ts` | Symlink target for local-dev installs |
| `examples/` | Copyable patterns only — not product features |
| `scripts/run-tests.mjs` | Walks `dist/**/*.test.js`, spawns each sequentially under `node --test` |
| `scripts/check-sdk-matrix.sh` | SDK compat runner |
| `scripts/smoke/pi-runtime-smoke.sh` | Manual runtime smoke |
| `dist/` | Build output |

## Public surface

- Runtime: `pi-yaml-hooks` (default export = PI extension)
- Type-only: `pi-yaml-hooks/types` re-exports `HookConfig`, `HookEvent`, `BashHookContext`, `SessionDeletedReason`, etc. No runtime resolver. Smoke: `src/public-types-smoke.test.ts`.

## Built-ins

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
- `action: stop` only effective on `tool.before.*`. `async: true` + `action: stop` rejected at parse time; runtime warns once per source per runtime instance as safety net
- `session.deleted` envelope carries `reason` ∈ `quit|reload|new|resume|fork`
- `user_bash` opt-in via `PI_YAML_HOOKS_ENABLE_USER_BASH=1`
- `tool_args` redacted via `sanitizeToolArgsForSerialization` before bash stdin (`src/core/runtime/actions.ts`)

## Config + trust

- One global root + one project root; each may `imports:` more
- Project discovery repo/worktree-aware, not exact-cwd
- Trust against repo/worktree anchor; project hooks ignored until trusted
- Project imports rejected if canonical path escapes anchor; bypass via `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1`
- Shortcuts: `/hooks-trust` or `PI_YAML_HOOKS_TRUST_PROJECT=1`

## Caps

YAML 1 MiB · import depth 32 · canonicalize depth 32 · snapshot LRU 16 · runtime registry per-cwd LRU 8 · recursion-guard depth 32 · per-pattern glob LRU 256 · pending tool-calls 1000 (TTL 5 min, FIFO) · `tool_args` 64 KiB · session lineage cache 64 / depth 64 / header 64 KB

## Host abstraction

`HookPolicy` (`src/core/types.ts`) plugs host-specific diagnostics into the loader. Core ships `NOOP_POLICY`; `src/pi/unsupported.ts` registers the PI policy via `setActiveHookPolicy`. Never import `src/pi/*` from `src/core/*`.

## Env vars

Canonical reference: [`docs/setup.md#environment-variables`](docs/setup.md#environment-variables). Do not duplicate.

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
| `npm run test:internal` | Builds first, then `node scripts/run-tests.mjs`. Known flake: `timed out bash hooks kill descendant background processes on POSIX` |
| `npm run compat:sdk-matrix[:dry-run]` | Peer-range check in temp clone |
| `npm run compat:sdk-matrix:future` | Advisory next-minor probe; does not widen peer |
| `scripts/smoke/pi-runtime-smoke.sh` | Runtime smoke; keep evidence on SDK-widening PRs |

`npm test` is a consumer no-op; use `test:internal`.

## Quirks

- Atomic-commit hook auto-commits per Edit/Write; one commit per edit
- `prepack` runs `build:publish` (clean rebuild via `tsconfig.publish.json`)
- `scripts/tail-hook-log.sh` backs `/hooks-tail-log`
- `load-hooks.ts` and `pi/adapter.ts` are thin re-export barrels — implementation in `core/hooks/` and `pi/{host-adapter,register-adapter,session-lifecycle,runtime-registry,event-mappers}.ts`. `runtime.ts` is the factory + per-runtime state holder; dispatch lives in `core/runtime/`.

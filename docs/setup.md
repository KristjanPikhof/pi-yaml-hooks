# Setup

This guide gets `pi-hooks` installed and gives you a safe place to put `hooks.yaml`.

## Requirements

- macOS or Linux
- Node.js `>= 22.0.0`
- `bash` on `PATH`
- `@mariozechner/pi-coding-agent ^0.68.1 || ^0.69.0`

Windows is unsupported because the hook runner expects a POSIX `bash`.

This repository documents the peer support range exactly as `^0.68.1 || ^0.69.0`. Older 0.67-era installs are no longer part of the documented contract, even if some behavior still happens to work.

## Install the extension

`pi-hooks` is installable as a PI package straight from git. That should be your default unless you are actively editing a local checkout.

### Recommended: `pi install`

```bash
# SSH
pi install git:git@github.com:KristjanPikhof/pi-yaml-hooks

# HTTPS
pi install https://github.com/KristjanPikhof/pi-yaml-hooks
```

By default this writes to `~/.pi/agent/settings.json`. Add `-l` to install into `.pi/settings.json` for the current project instead.

### Add it through `packages`

If you prefer to edit settings directly, add the git source to the `packages` array.

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

Project settings override global ones, and PI installs missing project packages automatically on startup.

### Other install options

| Method | Use when |
|---|---|
| `pi -e git:git@github.com:KristjanPikhof/pi-yaml-hooks` | You want a one-off run without writing settings |
| `ln -s "$PWD/extensions/index.ts" ~/.pi/agent/extensions/pi-hooks.ts` | You are editing a local checkout and want PI to load that working tree |
| `<project>/.pi/extensions/pi-hooks.ts` | You want a project-local local-dev install from a checkout |

## Create your first hook file

The preferred global location is:

```text
~/.pi/agent/hook/hooks.yaml
```

Create it like this:

```bash
mkdir -p ~/.pi/agent/hook
cat > ~/.pi/agent/hook/hooks.yaml <<'YAML'
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
YAML
```

Then start PI:

```bash
pi
```

You should see a startup summary like:

```text
[pi-hooks] Loaded 1 hook (global: 1, project: 0).
```

## Hook file locations

`pi-hooks` checks at most one global root file and one project root file.

### Global locations

Checked in this order:

1. `~/.pi/agent/hook/hooks.yaml`
2. `~/.pi/agent/hooks.yaml`

Windows is not a supported runtime, even if some internal path discovery code recognizes Windows-style locations.

### Project locations

Checked in this order:

1. `<project>/.pi/hook/hooks.yaml`
2. `<project>/.pi/hooks.yaml`

Within each scope, the first existing path wins.

Each discovered root file may also declare top-level imports:

```yaml
imports:
  - ./hooks.d
  - ./base.yaml
  - my-shared-hooks
hooks:
  - event: session.created
    actions:
      - notify: "ready"
```

Import rules:

- imports load before the importing file's own hooks
- relative imports resolve from the importing file
- non-relative imports resolve through Node module resolution
- directory imports expand files in stable lexical order
- repeated imports are deduped by canonical path
- import cycles and missing imports are load errors
- imported files inherit the root file scope (`global` or `project`)
- trust is still decided only at the discovered project root file

## Trust project hooks

Project hooks can run arbitrary `bash`, so they are disabled by default.

### One-session trust

```bash
PI_HOOKS_TRUST_PROJECT=1 pi
```

### Persistent trust

Add the absolute repo/worktree trust anchor path to:

```text
~/.pi/agent/trusted-projects.json
```

Example:

```json
[
  "/Users/me/code/my-project"
]
```

If a project hook file exists but the repo/worktree is not trusted, `pi-hooks` prints a warning once and skips that file.

For nested packages, monorepos, and linked worktrees, `pi-hooks` resolves the nearest project hook root up to the current git worktree root and evaluates trust against that repo/worktree anchor, not just the current cwd string.

## How loading works

The load order is:

1. global root file imports, then global root hooks
2. trusted project root file imports, then project root hooks

That means:

- both roots and their imports can contribute active hooks
- the project root does not automatically replace the global root
- replacement only happens when the later file uses `override:` against a hook `id`

For exact override behavior, see [`hooks-reference.md`](./hooks-reference.md).

## Hook file reload behavior

`pi-hooks` re-checks discovered hook files on later events. If file size or modification time changes, it reloads the active hook set automatically.

In practice this means:

- edit `hooks.yaml`
- trigger another PI event
- the new hook set is picked up without reinstalling the extension

If reload fails, PI keeps the last known good hook set and logs the parse errors.

## Native `/hooks-*` commands

Once the extension is loaded, PI exposes these helper commands:

- `/hooks-status` — inspect the active hook summary, paths, trust state, and log file
- `/hooks-validate` — validate active hooks and explain whether the project file is valid but untrusted
- `/hooks-trust` — trust the current project without manually editing `trusted-projects.json`
- `/hooks-reload` — reload extensions and command surfaces on demand
- `/hooks-tail-log` — show the log file path and a ready-made tail command

## Useful environment variables

| Variable | What it does |
|---|---|
| `PI_HOOKS_TRUST_PROJECT=1` | Temporarily trust the current project |
| `PI_HOOKS_BASH_EXECUTABLE=/path/to/bash` | Use a different bash executable |
| `PI_HOOKS_MAX_OUTPUT_BYTES=4194304` | Raise the per-hook stdout/stderr capture cap |
| `PI_HOOKS_DEBUG=1` | Print extra debug logging |
| `PI_HOOKS_CONFIRM_AUTO_APPROVE=1` | In headless mode, auto-approve `confirm:` instead of denying |
| `PI_HOOKS_ENABLE_USER_BASH=1` | Route human `!` / `!!` shell commands through `tool.before.bash` hooks |

## First troubleshooting steps

1. Check Node: `node --version`
2. Check bash: `which bash`
3. Start PI and look for `[pi-hooks] Loaded ...`
4. If using project hooks, confirm trust is enabled
5. If using UI actions, make sure PI is running with a UI surface

## Runtime PI smoke checklist

Run this checklist before widening PI SDK support or merging changes that touch session lifecycle, slash commands, UI actions, prompt injection, or tool-event routing. Unit tests cover the adapter contracts, but these checks use a real PI process for behavior the SDK does not expose cleanly in tests.

### Prepare the smoke project

From the `pi-hooks` checkout:

```bash
scripts/smoke/pi-runtime-smoke.sh
```

The script creates a temporary project, copies [`scripts/smoke/pi-runtime-smoke-hooks.yaml`](../scripts/smoke/pi-runtime-smoke-hooks.yaml) to `.pi/hook/hooks.yaml`, parses the valid and intentionally invalid smoke fixtures, and writes `.pi/hooks-smoke/evidence.md` for release notes.

Start PI with the command printed by the script. It uses:

- `PI_HOOKS_TRUST_PROJECT=1` so project hooks load without editing trust files
- `PI_HOOKS_DEBUG=1` and `PI_HOOKS_LOG_FILE=<smoke-project>/.pi/hooks-smoke/pi-hooks.ndjson` for persistent evidence
- `PI_HOOKS_ENABLE_USER_BASH=1` so human `!` / `!!` shell commands are routed through `tool.before.bash`
- `pi -e <checkout>/extensions/index.ts` so the local checkout is tested

### Run the checks

| Area | Action | Expected observation | Evidence to keep |
|---|---|---|---|
| Startup and `session.created` | Start PI in the smoke project. | Startup prints a `[pi-hooks] Loaded ...` summary. The status bar or UI status surface shows `pi-hooks smoke: session created` when available. `.pi/hooks-smoke/events.ndjson` contains `session.created`. | Startup transcript, events file, and `pi-hooks.ndjson` excerpt. |
| `/hooks-status` | Run `/hooks-status`. | Command reports active smoke hooks, project config path, trusted project state, and log path. On PI versions with custom messages, the response is structured in-session diagnostics rather than only plain text. | Command transcript or screenshot. |
| `/hooks-validate` success | Run `/hooks-validate` with the valid smoke config. | Validation succeeds and includes the active project config. | Command transcript. |
| Custom diagnostic failure path | Replace `.pi/hook/hooks.yaml` with `scripts/smoke/pi-runtime-smoke-invalid-hooks.yaml`, then run `/hooks-reload` and `/hooks-validate`. Restore the valid file afterward. | The unsupported `command:` action is rejected as a PI load error, and PI shows the validation details. Existing last-known-good hooks are not silently replaced by the invalid config. | Diagnostic message, log excerpt, and note that the valid file was restored. |
| `/hooks-reload` | Restore the valid fixture and run `/hooks-reload`, then `/hooks-status`. | Reload succeeds, active smoke hooks return, and command/autocomplete surfaces remain available. | Reload transcript. |
| `tool.before.bash` and confirm | Ask PI to run a harmless shell command, for example `echo smoke-before-bash`. | A confirmation prompt appears before the bash tool runs. Approving lets the command continue, and `events.ndjson` records `tool.before.bash`. Rejecting in a separate pass blocks the tool call. | Prompt screenshot/transcript and events file. |
| `tool.after.read` and follow-up prompt | Ask PI to read `README.md`. | `events.ndjson` records `tool.after.read`. The `tool:` action sends a follow-up prompt asking PI to read `.pi/hooks-smoke/events.ndjson`; PI may ask for or perform that read in the current session. | Conversation transcript and events file. |
| `tool.after.write` and `file.changed` | Ask PI to write `.pi/hooks-smoke/write-check.txt`. | `events.ndjson` records `tool.after.write` with changed file data, then `file.changed` for the smoke path. | Events file. |
| `user_bash` opt-in | In interactive PI, run a human shell command with `! echo smoke-user-bash`. | Because `PI_HOOKS_ENABLE_USER_BASH=1` is set, the same `tool.before.bash` confirm path runs before the user command. No `tool.after.*` or `file.changed` event is expected for `user_bash`. | Prompt transcript and note that no after event was expected. |
| Idle | Let the agent finish a turn. | `.pi/hooks-smoke/events.ndjson` records `session.idle`, and status updates to `pi-hooks smoke: idle observed` when UI status is available. | Events file. |
| Session switch | Run `/new`. Optionally check `/resume` and `/fork` when available. | `/new` causes lossy `session.deleted` cleanup for the previous session and a fresh `session.created`. `/resume` and `/fork` should not double-run cleanup when PI emits both switch and shutdown lifecycle hooks. Existing-session re-entry should not re-fire `session.created`. | Events file with ordering notes. |
| `/quit` | Run `/quit`. | PI exits cleanly. If PI emits shutdown lifecycle hooks, the smoke event log may include lossy `session.deleted` cleanup for the active session. | Terminal transcript and final events file. |
| 0.70.x future gate | In a separate checkout or temporary matrix run, execute `npm run compat:sdk-matrix:future`, then run this same smoke procedure against 0.70.x before changing `peerDependencies`. | Treat failure to expose built-in tools, slash commands, custom messages, autocomplete, or lifecycle hooks as a release blocker. Passing the future matrix alone is advisory and does not widen support. | Matrix output plus full smoke evidence. |

### Evidence template

Use the generated `.pi/hooks-smoke/evidence.md` as the release artifact. Fill in PI version, SDK package versions, OS, command transcripts, `events.ndjson`, and relevant `pi-hooks.ndjson` excerpts. Mark each row pass or fail. If a row is not runnable in the current PI surface, record the exact reason and whether the expected behavior remains covered by unit tests.

## SDK compatibility checks for maintainers

The supported PI SDK peer range is `^0.68.1 || ^0.69.0`. Keep that range honest by running the compatibility matrix before merging SDK-sensitive changes:

```bash
npm run compat:sdk-matrix
```

This command is safe for normal development state. It copies the repository to a temporary directory, installs the matching `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` pair for each SDK spec, then runs the normal verification commands in the temporary copy:

1. `npm run typecheck`
2. `npm test`

The default matrix covers:

- `0.68.1` — minimum supported SDK
- `0.69.x` — current supported SDK line

Use `npm run compat:sdk-matrix:dry-run` to print the exact workflow without installing temporary dependencies.

`0.70.x` is intentionally not part of the documented peer range yet. Maintainers can run `npm run compat:sdk-matrix:future` as an advisory future gate, but passing that command alone does not widen package support.

## Next step

Once the extension loads, continue with [`hooks-reference.md`](./hooks-reference.md) or copy from [`examples/`](./examples/).

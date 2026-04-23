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

## Next step

Once the extension loads, continue with [`hooks-reference.md`](./hooks-reference.md) or copy from [`examples/`](./examples/).

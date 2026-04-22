# Setup

This guide gets `pi-hooks` installed and gives you a safe place to put `hooks.yaml`.

## Requirements

- macOS or Linux
- Node.js `>= 22.0.0`
- `bash` on `PATH`
- `@mariozechner/pi-coding-agent >= 0.68.1`

Windows is currently a no-op because the hook runner expects a POSIX `bash`.

This repository now treats Pi 0.68.1 as the compatibility target. Older 0.67-era installs are no longer the documented contract even if some behaviors still happen to work.

## Install the extension

### Recommended: global extension symlink

```bash
git clone https://github.com/KristjanPikhof/pi-hooks
cd pi-hooks
bun install
ln -s "$PWD/src/index.ts" ~/.pi/agent/extensions/pi-hooks.ts
```

This lets PI auto-discover the extension.

### Other install options

| Method | Use when |
|---|---|
| `pi -e /path/to/pi-hooks/src/index.ts` | You want a one-off test without changing your global setup |
| `<project>/.pi/extensions/pi-hooks.ts` | You want a project-local install |

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

`pi-hooks` checks at most one global file and one project file.

### Global locations

Checked in this order:

1. `~/.pi/agent/hook/hooks.yaml`
2. `~/.pi/agent/hooks.yaml`
3. `%APPDATA%/pi/agent/hook/hooks.yaml` on Windows
4. `%APPDATA%/pi/agent/hooks.yaml` on Windows

### Project locations

Checked in this order:

1. `<project>/.pi/hook/hooks.yaml`
2. `<project>/.pi/hooks.yaml`

Within each scope, the first existing path wins.

## Trust project hooks

Project hooks can run arbitrary `bash`, so they are disabled by default.

### One-session trust

```bash
PI_HOOKS_TRUST_PROJECT=1 pi
```

### Persistent trust

Add the absolute project path to:

```text
~/.pi/agent/trusted-projects.json
```

Example:

```json
[
  "/Users/me/code/my-project"
]
```

If a project hook file exists but the project is not trusted, `pi-hooks` prints a warning once and skips that file.

## How loading works

The load order is:

1. global hooks
2. trusted project hooks

That means:

- both files can contribute active hooks
- the project file does not automatically replace the global file
- replacement only happens when the later file uses `override:` against a hook `id`

For exact override behavior, see [`hooks-reference.md`](./hooks-reference.md).

## Hook file reload behavior

`pi-hooks` re-checks the discovered `hooks.yaml` files on later events. If file size or modification time changes, it reloads them automatically.

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

## First troubleshooting steps

1. Check Node: `node --version`
2. Check bash: `which bash`
3. Start PI and look for `[pi-hooks] Loaded ...`
4. If using project hooks, confirm trust is enabled
5. If using UI actions, make sure PI is running with a UI surface

## Next step

Once the extension loads, continue with [`hooks-reference.md`](./hooks-reference.md) or copy from [`examples/`](./examples/).

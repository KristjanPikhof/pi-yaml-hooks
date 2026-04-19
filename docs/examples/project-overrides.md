# Project overrides

Use this pattern when you want a personal global default but a trusted project needs different behavior.

## Step 1: define the global hook with an id

`~/.pi/agent/hook/hooks.yaml`

```yaml
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Global idle"
```

## Step 2: replace it in the project file

`<project>/.pi/hook/hooks.yaml`

```yaml
hooks:
  - override: idle-notify
    event: session.idle
    actions:
      - notify: "Project-specific idle"
```

## Step 3: trust the project

Either run PI with one-session trust:

```bash
PI_HOOKS_TRUST_PROJECT=1 pi
```

Or add the project path to `~/.pi/agent/trusted-projects.json`.

## Disable instead of replace

```yaml
hooks:
  - override: idle-notify
    disable: true
```

## Important note

Overrides are resolved against hooks that were already loaded earlier. The intended authoring pattern is later-file-over-earlier-file, especially project-over-global.

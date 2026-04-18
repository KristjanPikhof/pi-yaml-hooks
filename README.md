# pi-hooks

This is a port of https://github.com/KristjanPikhof/OpenCode-Hooks to the PI harness.

**Status:** in progress.

## Planned phases

1. **Phase 1 — MVP atomic-commit.** Bridge PI tool events into the Python
   `atomic-commit-snapshot-worker` so write/edit tool calls trigger the
   existing Python snapshot pipeline (git commits, SQLite queue, worker).
2. **Phase 2 — YAML runtime.** Port the host-agnostic YAML runtime so existing
   `hooks.yaml` files (`tool.before.*`, `tool.after.*`, `file.changed`,
   `session.*`, bash actions, conditions, scope main/child) work with minimal
   changes. `command:` actions hard-fail at load; `tool:` actions degrade to
   current-session prompts.
3. **Phase 3 — PI-native.** Add native YAML actions (`notify`, `confirm`,
   `setStatus`) wired to `ctx.ui`, plus `/snapshot-status` and `/snapshot-flush`
   slash commands and a live queue widget.

## Source

This port is derived from the OpenCode plugin:
https://github.com/KristjanPikhof/OpenCode-Hooks

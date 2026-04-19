# pi-hooks documentation

`pi-hooks` adds YAML-driven automation to PI. You define hooks in `hooks.yaml`, and PI runs them around tool calls, file mutations, and session lifecycle events.

## Start here

- [`setup.md`](./setup.md) — install the extension, choose hook file locations, and trust project hooks safely
- [`hooks-reference.md`](./hooks-reference.md) — exact hook fields, events, conditions, actions, and PI-specific behavior
- [`agent-authoring-guide.md`](./agent-authoring-guide.md) — practical rules for people and agents writing `hooks.yaml`
- [`debugging-hooks.md`](./debugging-hooks.md) — persistent hook logs, tailing, and debugging workflow
- [`examples/`](./examples/) — copy-paste examples for each major capability

## What pi-hooks can do today

- Run `bash` before or after tool calls
- Block pre-tool calls from `bash` hooks with exit code `2`
- Ask for user confirmation before a tool runs
- Show UI notifications and status-bar entries when PI has a UI surface
- Send follow-up prompts back into the current PI session with `tool:` actions
- React to session lifecycle events: `session.created`, `session.idle`, and `session.deleted`
- React to `file.changed`, which PI synthesizes after recognized file mutations
- Filter hooks by file extension or glob patterns
- Restrict hooks to `all`, `main`, or `child` sessions
- Queue selected hooks asynchronously so they do not block the agent turn
- Layer one global hook file and one trusted project hook file, with id-based replacement or disable behavior

## Important PI-specific realities

These are the details that matter most when authoring hooks:

- Only one global config and one project config are loaded.
- Both files stay active unless the later file explicitly overrides or disables earlier hooks by `id`.
- Project hook files are ignored until the project is trusted.
- `command:` actions are rejected at load time on PI.
- `tool:` does not imperatively invoke a tool; it sends a follow-up prompt to the current session.
- `confirm:` blocks only on `tool.before.*` hooks.
- `session.deleted` is intentionally lossy: PI fires it for shutdown and for session switches like `/new`, `/resume`, and `/fork`.
- `file.changed` is synthesized from recognized mutation tools. On stock PI that means `write`, `edit`, and some `bash` commands such as `mv`, `rm`, `touch`, and `mkdir`.

## Recommended reading order

If you are new to the project:

1. Read [`setup.md`](./setup.md)
2. Skim [`hooks-reference.md`](./hooks-reference.md)
3. Copy from [`examples/`](./examples/)
4. Keep [`agent-authoring-guide.md`](./agent-authoring-guide.md) open while writing new hooks

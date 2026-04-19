# Hooks reference

This document describes the current `pi-hooks` behavior as implemented in this repository.

## Hook file shape

A hook file must parse to an object with a top-level `hooks:` array.

```yaml
hooks:
  - id: example
    event: session.idle
    scope: all
    runIn: current
    conditions:
      - matchesCodeFiles
    actions:
      - notify: "Done"
```

Each action entry must define exactly one action key.

## Load order and precedence

`pi-hooks` loads at most:

- one global hook file
- one trusted project hook file

The order is always:

1. global
2. project

Without overrides, hooks from both files stay active.

## Hook fields

| Field | Required | Type | Exact behavior |
|---|---|---|---|
| `id` | no | string | Stable hook name used by later-file overrides. Strongly recommended for any hook you may replace or disable later. |
| `event` | yes | string | One of the supported hook events listed below. |
| `actions` | yes | array | Non-empty list of action objects. Actions run in order. |
| `action` | no | `stop` | Accepted only on `tool.before.*` hooks. On PI it does not add much beyond the normal pre-tool block behavior. |
| `conditions` | no | array | Additional filters. All conditions must pass. |
| `scope` | no | `all`, `main`, `child` | Filters which session lineage the hook itself runs in. Defaults to `all`. |
| `runIn` | no | `current`, `main` | Compatibility field for action targeting. Defaults to `current`. See the PI-specific notes below before relying on it. |
| `async` | no | boolean | Queues the hook for serialized background execution. Only allowed on non-`tool.before` hooks, not on `session.idle`, and only for `bash`-only hooks. |
| `override` | no | string | Replaces a previously loaded hook with the given `id`. |
| `disable` | no | boolean | When used with `override`, removes the targeted earlier hook instead of replacing it. |

## Supported events

### Tool events

| Event | When it fires | Can block? |
|---|---|---|
| `tool.before.*` | Before every tool call | yes |
| `tool.before.<name>` | Before a specific tool call | yes |
| `tool.after.*` | After every tool call | no |
| `tool.after.<name>` | After a specific tool call | no |

On stock PI, built-in tool names are:

- `bash`
- `read`
- `edit`
- `write`
- `grep`
- `find`
- `ls`

Custom tool names can also match if the host emits them.

### Session and file events

| Event | When it fires | Notes |
|---|---|---|
| `file.changed` | After recognized file mutations | Synthesized by `pi-hooks`; see below for exact sources |
| `session.created` | On PI startup or a genuinely new session | Does not fire on resume, reload, or fork re-entry |
| `session.idle` | When the agent loop ends and there are no pending messages | Includes accumulated file changes since the last successful idle dispatch |
| `session.deleted` | On shutdown and before session switches | Lossy by design; PI does not distinguish closed vs switched sessions |

### Exact `file.changed` behavior

`file.changed` is synthesized from the tool result payload.

On stock PI today it can come from:

- `write`
- `edit`
- `bash`, but only when the command text looks like one of these operations:
  - `rm` or `git rm`
  - `mv` or `git mv`
  - `cp` or `git cp`
  - `touch`
  - `mkdir`

For direct `write` and `edit` tool calls, the current implementation reports the target path as a `modify` change.

If you install custom tools named `multiedit`, `patch`, or `apply_patch`, the runtime can also synthesize `file.changed` from them.

## Conditions

Conditions are ANDed together. If any condition fails, the hook does not run.

### `matchesCodeFiles`

```yaml
conditions:
  - matchesCodeFiles
```

This passes when at least one known code or config file extension is present in the event's file list.

Practical note:

- it is most useful on `file.changed`, `tool.after.<mutation>`, and `session.idle`
- on events with no file context, it will not match

### `matchesAnyPath`

```yaml
conditions:
  - matchesAnyPath:
      - "src/**/*.ts"
      - "package.json"
```

This passes when any changed path matches any listed glob.

### `matchesAllPaths`

```yaml
conditions:
  - matchesAllPaths:
      - "src/**"
```

This passes when every changed path matches at least one glob in the list.

Important detail: this is an allowlist over paths, not a per-path intersection of all patterns.

If you want an intersection such as “all changed paths are under `src/` and all are `*.ts`”, write two separate conditions:

```yaml
conditions:
  - matchesAllPaths: "src/**"
  - matchesAllPaths: "**/*.ts"
```

### Path normalization rules

For path conditions:

- paths inside the current project are matched as project-relative paths like `src/index.ts`
- absolute paths outside the project stay absolute
- path separators are normalized to forward slashes

## Actions

### `bash`

Short form:

```yaml
actions:
  - bash: "echo hi"
```

Long form:

```yaml
actions:
  - bash:
      command: "./script.sh"
      timeout: 15000
```

Exact behavior:

- the command runs through `bash -c`
- default timeout is `60000` ms
- hook context JSON is written to the process stdin
- stdout and stderr are captured up to `PI_HOOKS_MAX_OUTPUT_BYTES` bytes total per stream buffer, default `1048576`
- on `tool.before.*`, exit code `2` blocks the tool call
- other non-zero exits are logged as hook failures but do not block

### `tool`

```yaml
actions:
  - tool:
      name: read
      args:
        path: README.md
```

Exact PI behavior:

- this does not imperatively execute the tool
- it sends a follow-up message into the current PI session saying to use that tool with those arguments
- cross-session targeting is not available on PI

### `notify`

Short form:

```yaml
actions:
  - notify: "Done"
```

Long form:

```yaml
actions:
  - notify:
      text: "Build finished"
      level: success
```

Levels:

- `info`
- `success`
- `warning`
- `error`

On PI, `success` is mapped to `info` because the current UI API does not expose a separate success level.

### `confirm`

```yaml
actions:
  - confirm:
      title: "Run command?"
      message: "Continue?"
```

Exact behavior:

- `message` is required
- `title` is optional; PI uses `Confirm` when omitted
- if the user rejects on a `tool.before.*` hook, the tool call is blocked
- on non-blocking events, rejection does not abort the event and later actions can still run
- in headless PI, confirm denies by default unless `PI_HOOKS_CONFIRM_AUTO_APPROVE=1`

### `setStatus`

Short form:

```yaml
actions:
  - setStatus: "Watching changes"
```

Long form:

```yaml
actions:
  - setStatus:
      text: "Working"
```

Exact behavior:

- this updates a PI status-bar slot when a UI surface exists
- status entries are keyed by `<source-file>#<event>`
- hooks from the same file on the same event share that slot
- the parser currently requires a non-empty status string

### `command`

```yaml
actions:
  - command: "/something"
```

This is rejected at load time on PI. The hook is dropped from the active hook map.

## `scope` versus `runIn`

These fields do different things.

### `scope`

`scope` filters where the hook itself is allowed to fire.

```yaml
scope: all
scope: main
scope: child
```

Exact behavior:

- `all` means every session
- `main` means only the root session in the current lineage
- `child` means only non-root sessions

### `runIn`

`runIn` is a compatibility field intended to target another session.

```yaml
runIn: current
runIn: main
```

Current PI caveats:

- `runIn: main` on non-`bash` actions is rejected at load time
- `tool:` actions still go to the current session because PI only exposes current-session prompt injection
- `bash` actions currently run with the current event context; do not rely on `runIn` to change the bash process session context

Practical guidance: prefer `scope` for real routing decisions and treat `runIn` as compatibility metadata unless you have verified the exact behavior you want.

## Async hooks

```yaml
- event: tool.after.write
  async: true
  actions:
    - bash: "./slow-hook.sh"
```

Exact rules:

- `async: true` is allowed only for non-`tool.before` hooks
- `async: true` is not allowed on `session.idle`
- async hooks must contain only `bash` actions
- hooks are serialized per `event + session`

Use async for slow post-processing that should not block the agent turn.

## Overrides and disable behavior

Overrides target hooks that were already loaded earlier.

That means the main supported pattern is:

- define a hook in the global file
- replace or disable it in the project file

### Replace an earlier hook

Global file:

```yaml
hooks:
  - id: idle-message
    event: session.idle
    actions:
      - notify: "Global idle"
```

Project file:

```yaml
hooks:
  - override: idle-message
    event: session.idle
    actions:
      - notify: "Project idle"
```

### Disable an earlier hook

```yaml
hooks:
  - override: idle-message
    disable: true
```

Important detail: the current loader resolves overrides against hooks loaded from earlier files. Same-file override entries are not a reliable authoring pattern.

## Bash hook stdin contract

Every `bash` action receives JSON on stdin.

Example shape for a `file.changed` hook:

```json
{
  "session_id": "session-123",
  "event": "file.changed",
  "cwd": "/Users/me/project",
  "files": ["src/index.ts"],
  "changes": [
    {"operation": "modify", "path": "src/index.ts"}
  ],
  "tool_name": "edit",
  "tool_args": {
    "path": "src/index.ts"
  }
}
```

Fields are omitted when unavailable.

Change objects use one of these shapes:

```json
{"operation": "create", "path": "..."}
{"operation": "modify", "path": "..."}
{"operation": "delete", "path": "..."}
{"operation": "rename", "fromPath": "old", "toPath": "new"}
```

## Bash environment variables

These environment variables are injected into every `bash` hook:

| Variable | Legacy alias | Meaning |
|---|---|---|
| `PI_PROJECT_DIR` | `OPENCODE_PROJECT_DIR` | Current project directory |
| `PI_WORKTREE_DIR` | `OPENCODE_WORKTREE_DIR` | Git worktree root when resolvable |
| `PI_SESSION_ID` | `OPENCODE_SESSION_ID` | Current session id |
| `PI_GIT_COMMON_DIR` | `OPENCODE_GIT_COMMON_DIR` | Git common dir for worktrees when resolvable |

The process working directory is the current project directory.

## Unsupported and advisory cases

| Case | Behavior |
|---|---|
| `command:` action | hard load error; hook is dropped |
| `runIn: main` with `tool:`, `notify:`, `confirm:`, or `setStatus:` | hard load error; hook is dropped |
| `tool.before.multiedit`, `tool.before.patch`, `tool.before.apply_patch` without matching custom tools | advisory only; they will not fire on stock PI |
| `session.deleted` | supported but lossy |
| `confirm:` in headless mode | deny by default |

## Debug logging

When you start PI with:

```bash
PI_HOOKS_DEBUG=1 pi
```

`pi-hooks` writes persistent NDJSON logs to:

```text
~/.pi/agent/logs/pi-hooks.ndjson
```

Useful environment variables:

| Variable | Meaning |
|---|---|
| `PI_HOOKS_DEBUG=1` | enable debug-level persistent logging |
| `PI_HOOKS_LOG_FILE=/path/file.ndjson` | override the log file location |
| `PI_HOOKS_LOG_LEVEL=debug|info|warn|error` | explicitly set the log level |
| `PI_HOOKS_LOG_STDERR=1` | mirror structured log entries to stderr |

The easiest way to inspect the log is:

```bash
./scripts/tail-hook-log.sh
```

For focused debugging, filter by hook or event:

```bash
./scripts/tail-hook-log.sh --hook load-writer-skill-when-markdown-changes
./scripts/tail-hook-log.sh --event session.idle
```

## Best next steps

- For installation and trust: [`setup.md`](./setup.md)
- For authoring advice: [`agent-authoring-guide.md`](./agent-authoring-guide.md)
- For copy-paste snippets: [`examples/`](./examples/)

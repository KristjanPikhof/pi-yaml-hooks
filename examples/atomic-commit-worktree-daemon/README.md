# Atomic commit worktree daemon

Design scaffold for a daemon-based snapshot example that can commit file
changes one stable file version at a time.

This is not a runnable hook pack yet. It is a concrete implementation plan and
hook contract for a future example. The current runnable autocommit example is
[`../atomic-commit-snapshot-worker/`](../atomic-commit-snapshot-worker/).

## Goal

The existing snapshot worker commits paths that PI can report through
`file.changed`. That misses transient states inside a single long-running
`bash` tool, for example:

```bash
printf '' > test.md && sleep 3 && printf 'hello' >> test.md && sleep 5 && rm test.md
```

A daemon-based design moves capture earlier. The daemon starts when the PI
session starts, records file lifecycle events while tools and shell commands
run, hashes file contents immediately into git blobs, and asks a worker to
publish one commit per stable file event.

Target commit stream for the command above:

```text
create test.md as empty file
modify test.md to "hello"
delete test.md
```

## Planned hook wiring

Use the future daemon controller from a trusted project hook file:

```yaml
hooks:
  - id: snapshot-daemon-start
    event: session.created
    actions:
      - bash: 'python3 <example-dir>/snapshot-daemonctl.py start --repo "$PI_PROJECT_DIR"'

  - id: snapshot-daemon-wake-before-tool
    event: tool.before.*
    actions:
      - bash: 'python3 <example-dir>/snapshot-daemonctl.py wake --repo "$PI_PROJECT_DIR"'

  - id: snapshot-daemon-flush-after-tool
    event: tool.after.*
    actions:
      - bash: 'python3 <example-dir>/snapshot-daemonctl.py flush --repo "$PI_PROJECT_DIR" --non-blocking'

  - id: snapshot-daemon-sleep-on-idle
    event: session.idle
    actions:
      - bash: 'python3 <example-dir>/snapshot-daemonctl.py flush --repo "$PI_PROJECT_DIR"'
      - bash: 'python3 <example-dir>/snapshot-daemonctl.py sleep --repo "$PI_PROJECT_DIR"'

  - id: snapshot-daemon-stop-on-delete
    event: session.deleted
    actions:
      - bash: 'python3 <example-dir>/snapshot-daemonctl.py stop --repo "$PI_PROJECT_DIR" --flush'
```

`session.idle` is PI's practical "after idle" surface. pi-hooks emits it from
PI `agent_end` only when the current session is idle and has no pending
messages. Use it for final drain and sleep, not for long background work.

See [`hooks.yaml`](./hooks.yaml) for the planned hook shape and
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the full build plan.

## Proposed files

| File | Purpose |
| --- | --- |
| `snapshot-daemonctl.py` | Small control CLI used by hooks: start, wake, flush, sleep, stop, status. |
| `snapshot-daemon.py` | Per-worktree watcher process that records file lifecycle events. |
| `snapshot-capture.py` | Platform watcher backend and fallback rescan logic. |
| `snapshot-replay.py` | Commit publisher adapted from the current snapshot worker. |
| `snapshot_state.py` | SQLite schema, branch registry, shadow tree, and locks. |

The split keeps hook actions cheap. Hooks only control the daemon. Capture and
commit replay happen in long-lived processes.

## PI SDK findings

- PI exposes `session_start`, `agent_end`, `session_shutdown`,
  `session_before_switch`, `tool_call`, and `tool_result`.
- pi-hooks currently maps `session_start` with reason `startup` or `new` to
  `session.created`.
- pi-hooks maps `agent_end` to `session.idle` only when `ctx.isIdle()` is true
  and `ctx.hasPendingMessages()` is false.
- PI has no dedicated "after idle" event beyond `agent_end`.
- `session.deleted` is intentionally lossy on PI because shutdown also fires
  for `/new`, `/resume`, and `/fork`.
- `tool.before.*` is the best wake point before command execution.
- `tool.after.*` and `session.idle` are good flush points, but they are too late
  to discover transient filesystem states by themselves.

## Hook architecture changes to consider

This example can be built with today's hook events, but these changes would
make the daemon cleaner:

1. Add `session.resumed` or include PI `session_start.reason` in
   `session.created` payloads. The daemon can currently recover from missing
   starts by using `tool.before.*`, but explicit resume would be cleaner.
2. Add a first-class `agent.started` / `agent.ended` hook pair, or expose
   `agent_end` as its own event. Today `session.idle` is good enough for drain,
   but its name hides that it is tied to agent-loop completion.
3. Add a daemon-oriented action or helper command is optional, not required.
   The existing `bash` action can run `snapshot-daemonctl.py` safely.
4. Do not make `session.idle` async for this use case. The sleep command should
   be quick and synchronous so queued idle file-change state is consumed only
   after the drain request succeeds.

## Non-goals

- This is an example pattern, not a built-in product feature.
- It does not make `command:` actions work on PI.
- It does not change the meaning of `tool:` actions; those remain follow-up
  prompts to PI.
- It should not rely on `runIn: main` to alter shell process context.

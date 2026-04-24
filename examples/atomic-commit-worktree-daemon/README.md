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

## Capture contract

This example commits **stable file-event units**, not every filesystem syscall.
The daemon records an event after a path has settled long enough to hash the
content that should appear in the commit. The debounce window is a correctness
boundary: it collapses noisy write bursts, but it is not allowed to merge
distinct lifecycle events that the daemon can observe separately.

Canonical event vocabulary:

| Event unit | Commit semantics | Notes |
| --- | --- | --- |
| `create` | Add a path that was absent from the daemon shadow tree | Includes empty files and symlink creation. |
| `modify` | Replace the blob for an existing path | Includes truncation and content changes after close or debounce. |
| `delete` | Remove a path that existed in the daemon shadow tree | A native watcher can observe this even when no file remains to hash. |
| `rename` | Remove `old_path` and add `path` in one commit | Used only when the backend can pair source and destination. Otherwise this may degrade to delete + create. |
| `mode` | Change executable bit without changing content | Symlink retargets are represented as `modify` because the link target is the blob content. |

Each captured event owns one or more operations with:

- operation and path data (`path`, optional `old_path`)
- `before` blob and mode from the daemon shadow tree
- `after` blob and mode from immediate `git hash-object -w` when the path exists
- capture timestamp and backend fidelity
- branch ref, branch generation, and capture-time `base_head`

### Fidelity levels

The example must label capture fidelity honestly. Replay is safe only when the
event's branch identity is still valid; fidelity describes how complete the file
operation observation was.

| Fidelity | Source | Guarantee | Known misses |
| --- | --- | --- | --- |
| `watcher` | Native filesystem events such as inotify or FSEvents | Best available lifecycle stream for the current platform. Can distinguish deletes and many renames while tools run. | Native APIs can coalesce, drop, or reorder under load; the daemon must rescan and mark recovered paths accordingly. |
| `rescan` | Polling fallback that compares the live worktree with the shadow tree | Portable and deterministic for states present at scan time. | Can miss create-modify-delete cycles, short-lived files, or intermediate contents between scans. |
| `hook-payload` | pi-hooks `file.changed` payloads | Exact only for structured `changes[]` entries reported by pi-hooks. Useful as a reconciliation hint. | Too late to observe transient states inside a long-running tool; `files[]`-only payloads are path hints, not exact operations. |
| `strict-mount` | Future FUSE/macFUSE or overlay recorder mode | Intended to make all writes pass through a recorder. | Not part of this first example. Do not document it as available. |

Mixed-fidelity events are allowed. For example, a native watcher event may be
augmented by a rescan. Fidelity therefore belongs on each captured operation, or
on an equivalent structure that preserves which paths are exact and which were
inferred.

### State boundaries

State is deliberately split by ownership:

| Owner | State | Why |
| --- | --- | --- |
| Hook actions | No durable state beyond invoking `snapshot-daemonctl.py` | Hooks stay cheap and PI lifecycle-safe. They wake, flush, sleep, or stop the daemon; they do not watch files or create commits. |
| Daemon process | Heartbeat, watcher lifecycle, shadow tree, capture queue, flush acknowledgements | The daemon is the only process that observes filesystem transitions and mutates capture state. |
| Replay publisher | Temporary index, compare-and-swap publish state, reconcile state | Publishing is isolated from capture so slow commit work does not block watcher callbacks. |
| Repo-shared branch registry | Branch owner, generation, observed head/incarnation token | Worktree-local queues are safe only when branch identity is coordinated across linked worktrees. |

Hooks only control the daemon because PI lifecycle events are not a reliable
place to perform long-running work. `tool.before.*` is early enough to wake a
sleeping daemon before command execution. `tool.after.*`, `session.idle`, and
`session.deleted` are flush/control points; they are too late to discover file
states that appeared and disappeared while the tool was running.

### Branch and worktree safety

Replay is allowed only when all of these remain true:

- the worktree is on a symbolic branch, not detached `HEAD`
- the branch has an existing `HEAD` commit
- one worktree owns the branch at capture and replay time
- the live branch is still in the same branch generation as the event
- the live branch tip is a descendant of the event's `base_head`

If unsupported topology or stale generation is detected before enqueue, the
daemon rejects the event visibly. If it is detected after enqueue, the replay
publisher settles the event as `blocked_conflict` with an explicit reason. It
must not replay stale events opportunistically onto a rewritten or recreated
branch.

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

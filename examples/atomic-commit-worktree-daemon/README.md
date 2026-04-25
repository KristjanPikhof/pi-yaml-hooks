# Atomic commit worktree daemon

Runnable daemon-based snapshot example that can commit file changes one stable
file version at a time.

This is **not** a built-in `pi-hooks` feature. It is an opt-in example pack you
copy into a trusted project hook file. The daemon observes the worktree while PI
tools run, then publishes one git commit per captured file event.

The implementation currently uses a portable polling/rescan backend. Polling can
capture long-lived create/modify/delete states, but it can still miss files or
intermediate contents that appear and disappear between scans. Native watcher
and strict mount backends are documented as future fidelity levels, not as
available behavior.

## Use as a pi-hooks hook

### 1. Prerequisites

- macOS or Linux (the example uses POSIX signals and advisory locks)
- `python3` 3.x on `$PATH`
- `git` 2.x
- a repo/worktree with at least one existing commit
- a trusted project hook file under `<project>/.pi/hook/hooks.yaml` or
  `<project>/.pi/hooks.yaml`

Keep this example directory on disk. `pi install` alone does not give you a
stable example-script path to reference from YAML.

### 2. Copy the hook pack

Copy [`hooks.yaml`](./hooks.yaml) into your project hook file, then replace
`<example-dir>` with the absolute path to this
`examples/atomic-commit-worktree-daemon/` directory. The starter YAML assigns it
inside double quotes (`SNAPSHOT_DAEMON_DIR="<example-dir>"`) so paths with spaces
continue to work after replacement. Avoid double-quote, backslash, and shell
substitution characters (`"`, `\`, `` ` ``, `$`) inside `<example-dir>`; they
will break the surrounding `bash -c` action string.

The hook pack uses only `bash` actions. It does not rely on unsupported PI
`command:` actions, and it does not use `tool:` actions as imperative execution.

### 3. Verify it works

From a PI session inside the trusted repo, run a compound shell command that
keeps each state around long enough for polling to see it:

```bash
printf '' > test.md && sleep 3 && printf 'hello' >> test.md && sleep 3 && rm test.md
```

Then inspect history and daemon state:

```bash
git log --oneline --max-count=5
SNAPSHOT_DAEMON_DIR="<example-dir>"
python3 "$SNAPSHOT_DAEMON_DIR/snapshot-daemonctl.py" status --repo "$PI_PROJECT_DIR"
```

Expected history shape when polling catches all three states:

```text
Remove test.md
Update test.md
Add test.md
```

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

## Hook wiring

Use the daemon controller from a trusted project hook file:

```yaml
hooks:
  - id: snapshot-daemon-start
    event: session.created
    actions:
      - bash: 'SNAPSHOT_DAEMON_DIR="<example-dir>"; python3 "$SNAPSHOT_DAEMON_DIR/snapshot-daemonctl.py" start --repo "$PI_PROJECT_DIR"'

  - id: snapshot-daemon-wake-before-tool
    event: tool.before.*
    actions:
      - bash: 'SNAPSHOT_DAEMON_DIR="<example-dir>"; python3 "$SNAPSHOT_DAEMON_DIR/snapshot-daemonctl.py" wake --repo "$PI_PROJECT_DIR"'

  - id: snapshot-daemon-flush-after-tool
    event: tool.after.*
    actions:
      - bash: 'SNAPSHOT_DAEMON_DIR="<example-dir>"; python3 "$SNAPSHOT_DAEMON_DIR/snapshot-daemonctl.py" flush --repo "$PI_PROJECT_DIR" --non-blocking'

  - id: snapshot-daemon-sleep-on-idle
    event: session.idle
    actions:
      - bash: 'SNAPSHOT_DAEMON_DIR="<example-dir>"; python3 "$SNAPSHOT_DAEMON_DIR/snapshot-daemonctl.py" flush --repo "$PI_PROJECT_DIR"'
      - bash: 'SNAPSHOT_DAEMON_DIR="<example-dir>"; python3 "$SNAPSHOT_DAEMON_DIR/snapshot-daemonctl.py" sleep --repo "$PI_PROJECT_DIR"'

  - id: snapshot-daemon-stop-on-delete
    event: session.deleted
    actions:
      - bash: 'SNAPSHOT_DAEMON_DIR="<example-dir>"; python3 "$SNAPSHOT_DAEMON_DIR/snapshot-daemonctl.py" stop --repo "$PI_PROJECT_DIR" --flush'
```

`session.idle` is PI's practical "after idle" surface. pi-hooks emits it from
PI `agent_end` only when the current session is idle and has no pending
messages. Use it for final drain and sleep, not for long background work.

See [`hooks.yaml`](./hooks.yaml) for the copyable hook shape and
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the full build plan.

## Files

| File | Purpose |
| --- | --- |
| `snapshot-daemonctl.py` | Small control CLI used by hooks: start, wake, flush, sleep, stop, status. |
| `snapshot-daemon.py` | Per-worktree daemon process that records file lifecycle events and handles control requests. |
| `snapshot-capture.py` | Portable polling/rescan capture backend. |
| `snapshot-replay.py` | Commit publisher adapted from the current snapshot worker. |
| `snapshot_state.py` | SQLite schema, branch registry, shadow tree, and locks. |

The split keeps hook actions cheap. Hooks only control the daemon. Capture and
commit replay happen in long-lived processes.

## Operating commands

Run these from the example directory, or use absolute script paths.

```bash
# Start or ensure the per-worktree daemon exists
python3 snapshot-daemonctl.py start --repo /path/to/repo

# Wake the daemon before a tool or command runs
python3 snapshot-daemonctl.py wake --repo /path/to/repo

# Ask the daemon to publish pending events and wait for acknowledgement
python3 snapshot-daemonctl.py flush --repo /path/to/repo

# Ask for a quick non-blocking publish after each tool
python3 snapshot-daemonctl.py flush --repo /path/to/repo --non-blocking

# Pause polling after PI is idle; process state is retained
python3 snapshot-daemonctl.py sleep --repo /path/to/repo

# Flush, then stop; safe to call more than once
python3 snapshot-daemonctl.py stop --repo /path/to/repo --flush

# Inspect DB path, daemon heartbeat, queue counts, and publish state
python3 snapshot-daemonctl.py status --repo /path/to/repo

# Drain pending events directly without going through daemon control rows
python3 snapshot-replay.py --flush --repo /path/to/repo
```

## State and environment

The daemon stores worktree-local state under the worktree git dir:

| Path | Purpose |
| --- | --- |
| `<git-dir>/ai-snapshotd/daemon.db` | SQLite state, capture queue, shadow tree, control requests |
| `<git-dir>/ai-snapshotd/daemon.lock` | Singleton daemon lock |
| `<git-dir>/ai-snapshotd/control.lock` | Short controller lock |
| `<git-dir>/ai-snapshotd/publish.lock` | Replay/publish serialization lock |
| `<git-dir>/ai-snapshotd/worker.index` | Temporary replay index |
| `<git-common-dir>/ai-snapshotd/branch-registry/` | Shared branch generation and worktree ownership registry |

Useful settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SNAPSHOTD_POLL_INTERVAL` | `0.75` | Seconds between active polling scans |
| `SNAPSHOTD_SLEEP_INTERVAL` | `2.0` | Sleep-loop interval after `sleep` requests |
| `SNAPSHOTD_ACK_TIMEOUT` | `2.0` | Blocking controller wait for daemon acknowledgements |
| `SNAPSHOTD_HEARTBEAT_FRESH_SECONDS` | `15.0` | Age at which controller treats a heartbeat as stale |
| `SNAPSHOTD_SENSITIVE_GLOBS` | `.env,*.pem,*.key,…` | Comma-separated paths excluded from polling capture |
| `SNAPSHOTD_START_READY_TIMEOUT` | `1.0` | Seconds `start` waits for daemon heartbeat readiness |

## Troubleshooting

- `status` shows `degraded-no-daemon`: the controller could not find or start
  `snapshot-daemon.py`. Check the `<example-dir>` path in hooks.yaml.
- `flush` exits `2`: the daemon did not acknowledge before
  `SNAPSHOTD_ACK_TIMEOUT`. Run `status`, then `start`, then retry `flush`.
- Events become `blocked_conflict`: branch identity was unsafe for replay
  (detached/unborn branch, stale branch generation, branch rewrite, or
  unsupported same-branch multi-worktree topology).
- Polling missed a create/delete cycle: that is a known `rescan` limitation.
  Increase sleeps or lower `SNAPSHOTD_POLL_INTERVAL`; strict capture requires a
  future native/strict backend.
- The final tree does not contain a file that was created and deleted: check
  `git log --oneline`; the daemon should still have published the intermediate
  create, modify, and delete commits if polling observed each state.

For internal PI SDK research notes and hook architecture observations, see
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) "Appendix A: PI SDK
findings".

## Non-goals

- This is an example pattern, not a built-in product feature.
- It does not make `command:` actions work on PI.
- It does not change the meaning of `tool:` actions; those remain follow-up
  prompts to PI.
- It should not rely on `runIn: main` to alter shell process context.

# Implementation plan

**Status:** Shipped polling/rescan backend. Native watcher and strict-mount
mode remain future work; see fidelity table in README.md.

This plan creates a new daemon-based snapshot example for committing every
stable file change atomically. The first implementation should be conservative:
watch and replay safely, reject unsupported topologies, and document capture
fidelity honestly.

## 1. Define the capture contract

Atomic event units:

- file create after close/write
- file modify after close/write or truncate
- file delete after unlink
- rename after the destination appears
- symlink create or retarget
- executable-bit mode change

Do not commit every low-level write syscall. Commit stable file versions after
the writer closes the file or after a debounce window proves it is stable.
Use the README vocabulary exactly: `create`, `modify`, `delete`, `rename`, and
`mode`. A symlink retarget is a `modify` because the link target is the blob
content. A rename is a single event only when the backend can pair source and
destination; otherwise it degrades to delete + create with the appropriate
fidelity labels.

Persist each captured event with:

- operation: `create`, `modify`, `delete`, `rename`, `mode`
- path and optional old path
- captured timestamp
- before blob/mode from the daemon shadow tree
- after blob/mode from immediate `git hash-object -w`
- per-operation source fidelity: `watcher`, `rescan`, `hook-payload`
- branch ref, branch generation, and base head

Fidelity contract:

- `watcher`: native platform watcher event. Best available lifecycle stream, but
  still subject to native API coalescing and overflow.
- `rescan`: polling or recovery scan. Captures only states present at scan time;
  can miss create-delete cycles and intermediate contents between scans.
- `hook-payload`: pi-hooks payload hint. Exact only for structured `changes[]`;
  `files[]`-only payloads are best-effort path hints.
- `strict-mount`: future FUSE/macFUSE or overlay recorder mode. Out of scope for
  the first implementation and must not be described as runnable.

State ownership boundaries:

- hooks call `snapshot-daemonctl.py` only
- daemon owns watcher lifecycle, heartbeat, shadow tree, capture queue, and
  flush acknowledgements
- replay owns temporary index, compare-and-swap publish, and post-publish
  reconcile state
- repo-shared branch registry owns branch generation and worktree ownership

Safety rule: reject unsupported topology before enqueue when possible; otherwise
settle already-queued stale or unsupported events as `blocked_conflict`. Never
replay across detached HEAD, unborn branches, same-branch multi-worktree edits,
branch rewrites, branch deletion, or branch recreation.

## 2. Build the control CLI

Create `snapshot-daemonctl.py` with commands:

```text
start --repo <path>
wake --repo <path>
flush --repo <path> [--non-blocking]
sleep --repo <path>
stop --repo <path> [--flush]
status --repo <path>
```

Responsibilities:

- resolve repo root, git dir, and common dir
- open worktree-local state
- acquire a short control lock
- start the daemon if no fresh heartbeat exists
- signal the daemon with `SIGUSR1` for wake/flush
- wait for an ack row for blocking flush/stop
- return success if the daemon is already in the requested state

Hooks should call only this CLI.

## 3. Build the daemon process

Create `snapshot-daemon.py`.

Responsibilities:

- one daemon per worktree git dir
- maintain heartbeat and pid in SQLite
- own the watcher backend lifecycle
- maintain a shadow tree for paths under the repo
- write capture events to SQLite (event rows are mutated post-publish to record
  `state` and `commit_oid`, so they are not immutable)
- run replay in-process after new events; there is no separate replay worker
  process to notify
- sleep after idle by stopping active watchers while retaining process state
- wake quickly before the next tool runs

The daemon must survive duplicate `start` calls. It should use a lock file and
heartbeat freshness check, matching the current snapshot worker pattern.

## 4. Implement watcher backends

Two tiers are planned. Only the polling tier is shipped today.

1. Portable polling fallback (shipped):
   - scan mtime/size/inode/mode
   - hash changed files after they are stable
   - detect missing paths from the shadow tree

The polling fallback compares the live tree to `shadow_paths` and waits for a
path to remain stable across the debounce window before hashing. It emits fewer
events than a native watcher would, and every polling-derived operation is
marked `rescan` so users know the event was inferred from snapshots rather than
observed as a lifecycle transition.

### Future work

2. Native best-effort watcher (future):
   - Linux: inotify via a small optional dependency or `ctypes`.
   - macOS: FSEvents via a small optional dependency or polling fallback.

Native watchers can catch more transient states. Polling can still miss
create-delete cycles between scans. Document the fidelity difference when the
native tier lands.

Long-term strict mode (future):

- add FUSE/macFUSE or overlayfs recorder mode
- require users to work inside the mounted view
- capture create-write-delete sequences even when no final file remains

## 5. Adapt replay from the current worker

Reuse the current snapshot worker's safest pieces:

- worktree-local SQLite state under `<git-dir>/ai-snapshotd/`
- branch registry under `<git-common-dir>/ai-snapshotd/branch-registry/`
- temporary git index
- `git update-ref` compare-and-swap
- two-phase publish/reconcile for crash recovery
- deterministic commit message fallback

Change replay semantics:

- one commit per captured event by default
- daemon-side flush-request coalescing is shipped without a tunable knob; see
  `snapshot-daemon.py` `process_requests` for the implementation

## 6. State layout

Reuse the current state subdir, but use separate tables or a new schema:

```text
<git-dir>/ai-snapshotd/daemon.db
<git-dir>/ai-snapshotd/daemon.lock
<git-dir>/ai-snapshotd/control.lock
<git-dir>/ai-snapshotd/publish.lock
<git-dir>/ai-snapshotd/worker.index
<git-common-dir>/ai-snapshotd/branch-registry/
```

Core tables:

- `daemon_state`
- `shadow_paths`
- `capture_events`
- `capture_ops`
- `flush_requests`
- `publish_state`

Use schema versioning and quarantine incompatible local state, as the current
snapshot example already does.

## 7. PI hook integration

Use these lifecycle decisions:

- `session.created`: start daemon.
- `tool.before.*`: wake daemon before any tool mutates files.
- `tool.after.*`: non-blocking flush; useful for quick commits after each tool.
- `session.idle`: blocking flush, then sleep. This is the practical "after
  idle" hook in PI.
- `session.deleted`: blocking flush and stop.

Because PI `session.deleted` is lossy, `stop --flush` must be idempotent and
safe when the user resumes or forks rather than truly quits.

## 8. Required pi-hooks changes

The first version can ship without core changes. The current PI adapter already
provides the needed control points:

- `session_start` with reason `startup` or `new` becomes `session.created`
- `tool_call` becomes `tool.before.*`
- `tool_result` becomes `tool.after.*`
- `agent_end` becomes `session.idle` only after PI reports idle and no pending
  messages
- `session_shutdown` and `session_before_switch` become lossy `session.deleted`

Recommended future improvements:

- expose PI `session_start.reason` in hook payloads, or add `session.resumed`
  and `session.reloaded`
- expose `agent.start` and `agent.end` hook events for daemon wake/sleep naming
- update hook docs to explain `session.idle` as the agent-end drain point
- consider a helper for daemon lock/heartbeat status in `/hooks-status`

Avoid making daemon behavior built-in until the example proves reliable.

## 9. Test plan

Unit tests:

- path shadow state transitions
- create/modify/delete/rename/mode event encoding
- branch-generation rejection
- replay produces the expected tree per event
- duplicate daemonctl calls are idempotent
- `test_stop_flush_is_idempotent`: stop --flush is safe to call more than once
  (to be added by test-lane, task a1a9383a-...)

Integration tests (polling/rescan backend — shipped):

- `write` tool creates one commit
- `edit` tool creates one commit
- daemon sleeps on `session.idle` and wakes on `tool.before.*`

Integration tests (future — native watcher backend not yet shipped):

- bash redirection create/modify/delete sequence is captured by native watcher
  *(future work; requires native watcher backend — see section 4)*
- `session.deleted` flushes without double-running when PI emits both shutdown
  and before-switch *(future work; idempotency covered by
  `test_stop_flush_is_idempotent` above once added)*

Manual PI smoke:

- start PI in a trusted repo
- run a compound `bash` command that creates, modifies, then deletes a file
- verify three commits in `git log --oneline`
- run `/new`, `/resume`, and `/fork` to verify idempotent stop/start handling

## 10. Rollout

1. Land the scaffold and design docs. **DONE** on this branch (commits
   87b0445, 43b5f7f, 38f6288, 1fa1fcb, 16f1391).
2. Implement portable polling fallback first for shape and replay correctness.
   **DONE** on this branch (same commit range).
3. Add native watcher backend. *Future.*
4. Add strict FUSE/overlay mode only after the daemon contract is stable.
   *Future.*
5. Keep the copyable example marked as polling/rescan fidelity until native
   watcher smoke tests pass on macOS and Linux.

## Appendix A: PI SDK findings

Operating constraints surfaced while wiring the daemon to PI through pi-hooks.
These are research notes for pi-hooks maintainers, not user-facing docs.

- PI exposes `session_start`, `agent_end`, `session_shutdown`,
  `session_before_switch`, `tool_call`, and `tool_result`.
- PI `session_start` includes a reason (`startup`, `reload`, `new`, `resume`, or
  `fork`). pi-hooks intentionally maps only `startup` and `new` to
  `session.created`, so daemon start is tied to genuinely new sessions.
- pi-hooks maps `agent_end` to `session.idle` only when `ctx.isIdle()` is true
  and `ctx.hasPendingMessages()` is false. `session.idle` is the practical
  "after idle" hook in PI; PI has no dedicated event beyond `agent_end`.
- `session.deleted` is intentionally lossy on PI because shutdown also fires
  for `/new`, `/resume`, and `/fork`. `stop --flush` therefore must be
  idempotent.
- `tool.before.*` is the best wake point before command execution.
- `tool.after.*` and `session.idle` are good flush points, but they are too late
  to discover transient filesystem states by themselves.

Hook architecture changes to consider (not required for the initial example):

- Expose PI `session_start.reason` in hook payloads, or add `session.resumed`
  / `session.reloaded`. The daemon currently recovers via `tool.before.*`, but
  explicit resume would be cleaner.
- Add a first-class `agent.started` / `agent.ended` hook pair, or expose
  `agent_end` directly. `session.idle` works for drain today but its name hides
  that it is tied to agent-loop completion.
- A daemon-oriented action helper is optional. The existing `bash` action can
  run `snapshot-daemonctl.py` safely.
- Do not make `session.idle` async for this use case. The sleep command should
  be quick and synchronous so queued idle file-change state is consumed only
  after the drain request succeeds.

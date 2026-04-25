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
keeps each state around long enough for polling to see it. Each `sleep`
duration must exceed `SNAPSHOTD_POLL_INTERVAL` (default `0.75s`) so polling
can observe every state.

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

> **Polling-fidelity note:** The polling backend only observes states that are
> present at scan time. If a file is created and deleted in the time between
> two scans (shorter than `SNAPSHOTD_POLL_INTERVAL`, default `0.75s`), the
> daemon may see fewer than three commits — or none at all for very short-lived
> files. The `sleep 3` values in the example command above are chosen to exceed
> the poll interval so that each state is visible to at least one scan. If you
> see fewer commits than expected, try increasing the sleep durations or
> lowering `SNAPSHOTD_POLL_INTERVAL`. Strict per-syscall capture requires a
> future native or strict-mount backend.

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

Symlink blobs are the literal target string per git's convention, so an absolute
symlink target leaks the host path into git history; `SNAPSHOTD_SENSITIVE_GLOBS`
is the only filter the daemon applies against that leakage.

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

### Switching branches with the daemon running

`git checkout <other>` mid-session is supported and does not require restarting
the daemon. On the next poll tick (within `SNAPSHOTD_POLL_INTERVAL`):

- The daemon re-reads the live branch and bumps to the new `(branch_ref,
  branch_generation)` context.
- A scoped `bootstrap_shadow` rebuilds the shadow tree from `git ls-tree -r
  HEAD` of the new branch. Shadow rows for the previous branch stay in the
  table but are filtered out — no phantom delete/create events leak across.
- Any `pending` events captured under the previous branch are settled as
  `blocked_conflict` ("stale branch generation") on the next replay; they
  never accidentally commit onto the new branch.
- An in-flight publish that was mid-CAS gets resolved by `recover_publishing`
  on next replay: rewound to `pending` if the ref never moved, or marked
  `published` if the commit landed before the crash.

If `HEAD` is detached or the branch is owned by another worktree, the daemon
records `last_capture_error` instead of capturing; flushes will report this
back through `status` until you return to a supported topology.

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
| `hooks.yaml` | Copy this into your project hook file. |
| `IMPLEMENTATION_PLAN.md` | Design and build plan; see status banner. |
| `tests/` | Pytest regression tests for capture, replay, and daemon control flow. |

The split keeps hook actions cheap. Hooks only control the daemon. Capture and
commit replay happen in long-lived processes.

## Operating commands

Inside a PI hook, use `PI_PROJECT_DIR` for `--repo`; outside PI, substitute the
absolute repo path.

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

`daemon.db` retains every published capture event, op row, and acknowledged
flush request so the history is auditable after the fact. Default retention is
7 days; tune with `SNAPSHOTD_RETENTION_DAYS`.

Useful settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SNAPSHOTD_POLL_INTERVAL` | `0.75` | Seconds between active polling scans |
| `SNAPSHOTD_SLEEP_INTERVAL` | `2.0` | Sleep-loop interval after `sleep` requests |
| `SNAPSHOTD_ACK_TIMEOUT` | `30` | Seconds the controller waits for a daemon ack on blocking flush/stop before escalating. |
| `SNAPSHOTD_HEARTBEAT_FRESH_SECONDS` | `15.0` | Age at which controller treats a heartbeat as stale |
| `SNAPSHOTD_SENSITIVE_GLOBS` | see below | Comma-separated globs excluded from polling capture. Defaults cover env files (`.env`, `.env.*`), credential files (`.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`), kubeconfig variants (`kubeconfig`, `**/.kube/config`), `**/.aws/credentials`, `**/.docker/config.json`, SSH keys (`**/id_rsa*`, `**/id_ed25519*`, `**/id_ecdsa*`), TLS material (`**/*.pem`, `**/*.key`, `**/*.p12`, `**/*.pfx`, `**/*.crt`, `**/*.pkcs8`, `**/*.kdbx`), service-account JSON (`**/service-account*.json`), GPG/ASC files (`**/*.gpg`, `**/*.asc`), and the catch-alls `**/secrets/*` and `**/credentials*`. The full list lives in `snapshot_state.DEFAULT_SENSITIVE_GLOBS`. Setting this variable to an empty or whitespace-only value falls back to the built-in defaults; it does not disable filtering. Any pattern of the form `**/X` is automatically expanded to also match a bare `X` at the repo root, so top-level files are caught without extra entries. Setting it to a non-empty value replaces the built-in list entirely — include all desired patterns explicitly. |
| `SNAPSHOTD_RETENTION_DAYS` | `7` | Days of acked flush rows and terminal `capture_events` kept in `daemon.db` before the daemon prunes them. |
| `SNAPSHOTD_START_READY_TIMEOUT` | `1.0` | Seconds `start` waits for daemon heartbeat readiness |

## AI commit messages (optional)

Commit-message generation is a separate concern from capture fidelity. Whether AI is on or off, the daemon captures the same file events and commits the same tree contents. The only thing that changes is the text of each commit message.

### Fallback order

For each event the replay publisher resolves the commit message in this order:

1. **Stored AI batch message** — value from `capture_events.message`, written during the AI pre-pass before the commit loop.
2. **`SNAPSHOTD_COMMIT_MESSAGE_CMD` output** — stdout of the configured shell command, run once per event. Used when AI is off or skipped.
3. **Deterministic message** — derived from event type and path alone; always available, requires no network or external process.

Failures at tier 1 or tier 2 never block a commit or change the event state to `failed`. They silently fall through to the next tier. Only `git commit-tree` or `git update-ref` errors mark an event `failed` or `blocked_conflict`, the same as before AI was added.

### Env vars

| Variable | Default | Purpose |
| --- | --- | --- |
| `SNAPSHOTD_AI_ENABLE` | off | Set to `1`, `true`, or `yes` to enable AI commit messages. Also requires `OPENAI_API_KEY`. |
| `SNAPSHOTD_AI_MAX_QUEUE_DEPTH` | `2` | If the pending-event backlog exceeds this count, the AI pre-pass is skipped for that drain cycle. Increase to `50` or `100` when using chunked batching. |
| `SNAPSHOTD_AI_CHUNK_SIZE` | `20` | Events per OpenAI chat-completions request (clamped to `1..100`). One request covers many events; raise this before adding more API calls. |
| `SNAPSHOTD_COMMIT_MESSAGE_CMD` | unset | Shell command run once per event (parsed with `shlex.split`, not a shell). The event JSON is written to stdin; stdout becomes the commit message. Used as the second-priority fallback when AI is off or produced no result. |
| `OPENAI_API_KEY` | unset | Required to enable built-in AI mode. Leave unset to keep AI off. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL for the chat-completions endpoint. Must start with `https://`; an `http://` value is rejected and AI is skipped for the entire drain cycle. |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Model name sent in the chat-completions request. |
| `OPENAI_API_TIMEOUT` | `15.0` | Network timeout in seconds for each OpenAI request (also applied to `SNAPSHOTD_COMMIT_MESSAGE_CMD` subprocess). |

### How batch AI works

When AI is enabled and the backlog is at or below `SNAPSHOTD_AI_MAX_QUEUE_DEPTH`, the replay publisher does a pre-pass before building commits:

1. Find events whose `capture_events.message` is still `NULL`.
2. Split them into chunks of `SNAPSHOTD_AI_CHUNK_SIZE`.
3. Send one chat-completions request per chunk using JSON-mode structured output.
4. Persist returned messages into `capture_events.message`.
5. Build commits using stored messages. Any event whose chunk failed falls back to `SNAPSHOTD_COMMIT_MESSAGE_CMD` if configured, otherwise to the deterministic message.

The request uses the chat-completions API with a `json_schema` response format; the model must return a `messages` array keyed by event `seq`.

### Redaction

Before any data leaves the machine, paths matching the sensitive glob list are replaced with `<redacted: sensitive path>` in the diff payload. The same glob list that governs capture exclusions (see `SNAPSHOTD_SENSITIVE_GLOBS` above) is applied here. The full default pattern set lives in `_DEFAULT_SENSITIVE_PATTERNS` inside `snapshot-replay.py`. Setting `SNAPSHOTD_SENSITIVE_GLOBS` to a non-empty value replaces the built-in list entirely for both capture and message generation; an empty or whitespace-only value falls back to the built-in defaults.

### Security notes

- Built-in AI is off by default. Setting `SNAPSHOTD_AI_ENABLE=1` without `OPENAI_API_KEY` has no effect.
- `OPENAI_BASE_URL` must use `https://`. An `http://` base URL is rejected at the start of each drain cycle; no diffs are sent.
- `SNAPSHOTD_COMMIT_MESSAGE_CMD` is executed as a plain argv list, not through a shell.
- Redaction happens before any network call or subprocess invocation.

## Crash recovery and durability

The daemon has no network dependency: it reads/writes only the local SQLite
database and shells out to `git`. Connectivity loss is irrelevant.

For process crashes, `kill -9`, and PC reboots the design favours **safely
resumable** over lossless. Every persistence boundary uses an atomic primitive
and has an explicit recovery path that runs on next start:

| Crash point | Recovery |
| --- | --- |
| Mid-capture (`record_event`) | `BEGIN IMMEDIATE`/`COMMIT` rolls back partial writes atomically; `capture_events`, `capture_ops`, and `shadow_paths` stay consistent. |
| Mid-`apply_ops_to_index` | `worker.index` is the daemon's private index, not your `.git/index`. Next replay unlinks and re-reads from HEAD. |
| Between `commit-tree` and `update-ref` | `recover_publishing` runs at the top of every replay. If the ref never moved, the event is rewound to `pending`; if the commit is reachable, it is marked `published` (idempotent). |
| During `update-ref` | `git update-ref` is itself atomic — either the ref moved or it did not. `recover_publishing` picks the right outcome. |
| During reconcile `git reset` | Best-effort by design. stderr is captured into `daemon_meta.last_reconcile_error`. The tightened `live==captured AND captured==pre` predicate refuses to reset paths whose live state has drifted. |
| `kill -9` with `daemon.lock` held | The kernel releases `flock` on process exit; next `start` acquires it cleanly. |

Other safeguards on restart:

- **Stale heartbeat**: `status` overlays `mode=stale-heartbeat` with
  `heartbeat_age_seconds` when the row claims to be active but the pid is
  dead.
- **PID reuse**: every signal verifies a `daemon_token` written at startup.
  A recycled pid that belongs to an unrelated process never receives our
  `SIGUSR1` or `SIGTERM`.
- **Schema mismatch** (after upgrading pi-hooks): `ensure_state` calls
  `quarantine_incompatible_local_state`, which moves the entire
  `<git-dir>/ai-snapshotd/` aside under `ai-snapshotd.incompatible-<stamp>-<pid>/`
  and starts fresh. Old state is preserved for forensics, never silently
  overwritten.
- **Hostile environment**: every `git` invocation routes through
  `_clean_git_env`, which strips `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_OBJECT_DIRECTORY`, and the rest of the `GIT_*` namespace before
  spawning. A poisoned parent env cannot redirect commits.

Failures that cannot corrupt the daemon's state:

- Internet/network loss (no network calls at all).
- Concurrent daemon `start` attempts (loser exits with `EX_TEMPFAIL=75` and
  does not clobber the peer's row).
- Branch swaps mid-session (see "Switching branches with the daemon
  running").

What CAN accumulate but stays harmless: orphan blobs and commits in
`.git/objects` for events that ended `blocked_conflict` or crashed mid-publish.
These are reachable for `git gc` on its normal schedule.

## Cleanup and retention

The daemon prunes its own state on a 60-second wall-clock cycle while running:

- `flush_requests` rows are dropped 24h after they were acknowledged.
- `capture_events` rows in `published`, `failed`, or `blocked_conflict` state
  are dropped after `SNAPSHOTD_RETENTION_DAYS` (default `7`); their
  `capture_ops` rows cascade automatically via `ON DELETE CASCADE`.
- Live state — `pending` events, unacked flush rows, in-flight `publish_state`
  — is never auto-pruned, so an outage that left the daemon stopped does not
  eat queued user-visible work.

Prune failures are caught and logged into `daemon_meta.last_prune_error`; a
failed prune cycle does not crash the daemon.

What is **not** automatically cleaned (and may grow over time on long-lived
daemons):

| Thing | Notes |
| --- | --- |
| `shadow_paths` rows for old `(branch_ref, branch_generation)` pairs | Stay until that exact pair is re-bootstrapped. Rebuild cost is small but rows persist. |
| `<git-common-dir>/ai-snapshotd/branch-registry/<digest>.json` files | One file per branch ever observed; tiny but never auto-removed. |
| `ai-snapshotd.incompatible-<stamp>-<pid>/` quarantine dirs | Schema-mismatch fallouts. Inspect, then `rm -rf` manually when you no longer need forensics. |
| Lock files (`daemon.lock`, `control.lock`, `publish.lock`) | Reused on next start; never deleted. |
| Orphan `.git/objects/` blobs and commits | Cleaned by `git gc` on its normal schedule, not by the daemon. |

If `daemon.db` grows beyond what you are comfortable with, the supported reset
is to stop the daemon and delete the directory:

```bash
python3 snapshot-daemonctl.py stop --repo /path/to/repo --flush
rm -rf /path/to/repo/.git/ai-snapshotd     # or the worktree-local equivalent
python3 snapshot-daemonctl.py start --repo /path/to/repo
```

This drops the audit trail of past events and rebuilds the shadow tree from
HEAD on next start. Your published git history is in `.git/objects` and refs
and is never touched by this reset.

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
- Stale `daemon.lock`: if `start` reports a stale lock and `pgrep -f
  snapshot-daemon.py` confirms no daemon is running, `rm
  <git-dir>/ai-snapshotd/daemon.lock` and re-run `start`.
- `daemon.db` has grown large or you want a clean slate: see
  ["Cleanup and retention"](#cleanup-and-retention) for the supported reset.

For internal PI SDK research notes and hook architecture observations, see
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) "Appendix A: PI SDK
findings".

## Non-goals

- This is an example pattern, not a built-in product feature.
- It does not make `command:` actions work on PI.
- It does not change the meaning of `tool:` actions; those remain follow-up
  prompts to PI.
- It should not rely on `runIn: main` to alter shell process context.

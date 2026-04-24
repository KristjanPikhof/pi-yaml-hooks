# Examples

These examples are designed to be copied into `hooks.yaml` with minimal editing.

## Copy-paste examples

- [`notify-on-idle.md`](./notify-on-idle.md) — simplest possible visible hook
- [`confirm-before-bash.md`](./confirm-before-bash.md) — require user approval before any `bash` tool call
- [`block-destructive-bash.md`](./block-destructive-bash.md) — block selected `bash` commands with exit code `2`
- [`log-file-changes.md`](./log-file-changes.md) — capture `file.changed` payloads to a local log
- [`path-filters.md`](./path-filters.md) — run hooks only for selected files or directories
- [`session-scope.md`](./session-scope.md) — use `scope: all|main|child`
- [`project-overrides.md`](./project-overrides.md) — replace or disable a global hook from a trusted project file
- [`background-hooks.md`](./background-hooks.md) — run slow post-processing asynchronously
- [`tool-follow-up-prompts.md`](./tool-follow-up-prompts.md) — ask the current PI session to do something next
- [`tail-hook-logs.md`](./tail-hook-logs.md) — tail and filter the persistent hook log while debugging
- [`snapshot-autocommit.md`](./snapshot-autocommit.md) — hook up the included Python snapshot worker example

## Complete example packs

- [`../../examples/pre-tool-developer-guards/`](../../examples/pre-tool-developer-guards/) — pre-tool guards for risky bash, protected files, and dependency installs
- [`../../examples/post-tool-developer-feedback/`](../../examples/post-tool-developer-feedback/) — post-tool logging, status, and follow-up prompts for developer workflows
- [`../../examples/atomic-commit-snapshot-worker/`](../../examples/atomic-commit-snapshot-worker/) — advanced snapshot worker example

## Design scaffolds

- [`../../examples/atomic-commit-worktree-daemon/`](../../examples/atomic-commit-worktree-daemon/) — design scaffold for a future daemon-based atomic commit watcher

## Before you paste

- If you are using a project hook file, trust the project first.
- If a snippet references an absolute path, replace it with your real path.
- If the snippet uses `bash`, test it once with a harmless input before relying on it.

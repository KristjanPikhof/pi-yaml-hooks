# Example hook packs

These folders include complete example packs. Copy the `hooks.yaml` snippets
into a global or trusted project hook file, and keep any referenced scripts at
the paths used by the YAML or update those paths.

## Complete packs

- [`pre-tool-developer-guards`](./pre-tool-developer-guards/) — block risky shell commands and protected-file edits before tools run
- [`post-tool-developer-feedback`](./post-tool-developer-feedback/) — log useful post-tool context, update status, and nudge follow-up checks after developer-facing changes
- [`atomic-commit-snapshot-worker`](./atomic-commit-snapshot-worker/) — advanced opt-in snapshot worker example
- [`atomic-commit-worktree-daemon`](./atomic-commit-worktree-daemon/) — opt-in daemon snapshot example for long-running tool/file lifecycle capture

These are examples only. They are not built-in `pi-hooks` product features.

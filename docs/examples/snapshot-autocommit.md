# Snapshot autocommit

This repository includes a full Python example that auto-commits recognized file changes through a snapshot worker.

## Use the bundled example

- example directory: [`../../examples/atomic-commit-snapshot-worker/`](../../examples/atomic-commit-snapshot-worker/)
- detailed setup: [`../../examples/atomic-commit-snapshot-worker/README.md`](../../examples/atomic-commit-snapshot-worker/README.md)
- starter hook file: [`../../examples/atomic-commit-snapshot-worker/hooks.yaml`](../../examples/atomic-commit-snapshot-worker/hooks.yaml)

## Hook snippet

```yaml
hooks:
  - id: snapshot-autocommit
    event: file.changed
    async: true
    actions:
      - bash: 'python3 /abs/path/to/pi-hooks/examples/atomic-commit-snapshot-worker/snapshot-hook.py'

  - id: snapshot-flush-on-exit
    event: session.deleted
    actions:
      - bash: 'python3 /abs/path/to/pi-hooks/examples/atomic-commit-snapshot-worker/snapshot-worker.py --flush --repo "$PI_PROJECT_DIR"'
```

Replace `/abs/path/to/pi-hooks` with the actual clone path.

## When to use it

Use this example when you want:

- automatic git commits after edits settle
- a per-worktree queue and worker
- a more advanced example of `file.changed`, `async`, and `session.deleted`

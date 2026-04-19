# Background hooks

Use `async: true` when a post-processing hook is slow and should not block the agent turn.

## Hook snippet

```yaml
hooks:
  - id: async-change-log
    event: file.changed
    async: true
    actions:
      - bash: 'mkdir -p .pi-hook-logs && (sleep 2; date >> .pi-hook-logs/async.log)'
```

## What it does

After a file change event, the hook is queued and runs in the background for that session and event key.

## Quick test

1. Add the hook
2. Edit a file through PI
3. Confirm the agent turn finishes without waiting two seconds
4. Check `.pi-hook-logs/async.log`

## Rules

- async hooks must be `bash`-only
- async is not allowed on `tool.before.*`
- async is not allowed on `session.idle`

## Good uses

- enqueueing background work
- slow logging
- external integrations that should not block editing

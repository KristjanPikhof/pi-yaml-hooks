# Debugging hooks

`pi-hooks` can write persistent NDJSON debug logs when you start PI with:

```bash
PI_HOOKS_DEBUG=1 pi
```

## Log file

Default path:

```text
~/.pi/agent/logs/pi-hooks.ndjson
```

Override it with:

```bash
PI_HOOKS_LOG_FILE=/tmp/pi-hooks.ndjson PI_HOOKS_DEBUG=1 pi
```

## Tail the log

Raw tail:

```bash
tail -F ~/.pi/agent/logs/pi-hooks.ndjson
```

Pretty tail helper:

```bash
./scripts/tail-hook-log.sh
```

## What gets logged

When debug logging is enabled, `pi-hooks` logs:

- hook config load and reload events
- event dispatches such as `tool.before.*`, `tool.after.*`, and `session.idle`
- each hook considered for a matching event
- why a hook matched or was skipped
- each action start/result
- the exact prompt text queued by `tool:` actions
- bash result status, exit code, duration, stdout, and stderr

## Important note

These logs are written by the extension runtime, not by the PI session transcript.

That means:

- `~/.pi/agent/sessions/*.jsonl` will not contain the full hook debug trail
- the canonical hook log is `~/.pi/agent/logs/pi-hooks.ndjson`

## Useful environment variables

| Variable | Meaning |
|---|---|
| `PI_HOOKS_DEBUG=1` | enable debug-level persistent logging |
| `PI_HOOKS_LOG_FILE=/path/file.ndjson` | change the log file location |
| `PI_HOOKS_LOG_LEVEL=debug` | explicitly set the log level |
| `PI_HOOKS_LOG_STDERR=1` | mirror structured log entries to stderr as well |

#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${PI_HOOKS_LOG_FILE:-$HOME/.pi/agent/logs/pi-hooks.ndjson}"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "pi-hooks log file not found yet: $LOG_FILE" >&2
  echo "Start PI with PI_HOOKS_DEBUG=1 and trigger a hook first." >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  tail -F "$LOG_FILE" | jq -r '
    [
      (.ts // "-"),
      (.level // "info"),
      (.kind // "-"),
      (if .event then "event=" + .event else empty end),
      (if .hookId then "hook=" + .hookId else empty end),
      (if .action then "action=" + .action else empty end),
      (if .toolName then "tool=" + .toolName else empty end),
      (if .message then .message else empty end)
    ]
    | map(select(length > 0))
    | join(" | ")
  '
else
  tail -F "$LOG_FILE"
fi

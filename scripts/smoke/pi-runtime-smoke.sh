#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE_DIR="${1:-$(mktemp -d "${TMPDIR:-/tmp}/pi-hooks-runtime-smoke.XXXXXX")}" 
HOOK_DIR="$SMOKE_DIR/.pi/hook"
EVIDENCE_DIR="$SMOKE_DIR/.pi/hooks-smoke"
LOG_FILE="$EVIDENCE_DIR/pi-hooks.ndjson"

mkdir -p "$HOOK_DIR" "$EVIDENCE_DIR"
cp "$ROOT_DIR/scripts/smoke/pi-runtime-smoke-hooks.yaml" "$HOOK_DIR/hooks.yaml"

node --input-type=module - "$HOOK_DIR/hooks.yaml" "$ROOT_DIR/scripts/smoke/pi-runtime-smoke-invalid-hooks.yaml" <<'NODE'
import fs from 'node:fs';
import YAML from 'yaml';
for (const file of process.argv.slice(2)) {
  YAML.parse(fs.readFileSync(file, 'utf8'));
}
NODE

cat > "$EVIDENCE_DIR/evidence.md" <<EOF
# pi-hooks runtime smoke evidence

- Date:
- Tester:
- pi-hooks checkout: $ROOT_DIR
- Smoke project: $SMOKE_DIR
- PI version: 
- @mariozechner/pi-coding-agent version:
- @mariozechner/pi-tui version:
- Node version: $(node --version)
- OS: $(uname -a)
- Extension entry: $ROOT_DIR/extensions/index.ts
- Hook config: $HOOK_DIR/hooks.yaml
- Log file: $LOG_FILE

## Automated prep

\`scripts/smoke/pi-runtime-smoke.sh\` created the smoke project and parsed both fixture YAML files successfully.

## Manual run command

\`\`\`bash
cd "$SMOKE_DIR"
PI_HOOKS_TRUST_PROJECT=1 \\
PI_HOOKS_DEBUG=1 \\
PI_HOOKS_LOG_FILE="$LOG_FILE" \\
PI_HOOKS_ENABLE_USER_BASH=1 \\
pi -e "$ROOT_DIR/extensions/index.ts"
\`\`\`

## Results

| Step | Result | Notes or evidence |
|---|---|---|
| /hooks-status |  |  |
| /hooks-validate |  |  |
| /hooks-reload |  |  |
| custom diagnostics |  |  |
| tool.before.bash confirm |  |  |
| tool.after.read follow-up prompt |  |  |
| tool.after.write and file.changed |  |  |
| user_bash opt-in |  |  |
| session.created / idle / deleted |  |  |
| /new or session switch |  |  |
| /quit |  |  |
| 0.70.x no-builtin-tools gate |  |  |

## Attachments

- Copy relevant excerpts from \`$LOG_FILE\`.
- Copy \`.pi/hooks-smoke/events.ndjson\`.
- Save screenshots or terminal transcript for UI notifications, confirmations, status, and custom diagnostic messages.
EOF

cat <<EOF
Prepared pi-hooks runtime smoke project.

Smoke project: $SMOKE_DIR
Hook config:    $HOOK_DIR/hooks.yaml
Event log:      $EVIDENCE_DIR/events.ndjson
Hook log:       $LOG_FILE
Evidence:       $EVIDENCE_DIR/evidence.md

Run PI manually with:

  cd "$SMOKE_DIR"
  PI_HOOKS_TRUST_PROJECT=1 \\
  PI_HOOKS_DEBUG=1 \\
  PI_HOOKS_LOG_FILE="$LOG_FILE" \\
  PI_HOOKS_ENABLE_USER_BASH=1 \\
  pi -e "$ROOT_DIR/extensions/index.ts"

Then follow docs/setup.md#runtime-pi-smoke-checklist.
EOF

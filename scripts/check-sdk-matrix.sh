#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
INCLUDE_FUTURE=0
SDK_SPECS=("0.68.1" "0.69.x")

usage() {
  cat <<'USAGE'
Usage: scripts/check-sdk-matrix.sh [--dry-run] [--include-future] [--versions "<spec> [<spec>...]"]

Runs the normal pi-hooks verification suite against temporary installs of the Pi SDK
peer packages. The repository checkout, package.json, package-lock.json, and normal
node_modules are not modified; each SDK spec is installed in a throwaway copy.

Default matrix:
  - @mariozechner/pi-coding-agent@0.68.1 and @mariozechner/pi-tui@0.68.1
  - @mariozechner/pi-coding-agent@0.69.x and @mariozechner/pi-tui@0.69.x

Options:
  --dry-run         Print the matrix and commands without creating temp installs.
  --include-future Include the gated 0.70.x future target. This is advisory only and
                   does not change package peer support.
  --versions        Override SDK specs, for example: --versions "0.68.1 0.69.x".
  -h, --help        Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --include-future)
      INCLUDE_FUTURE=1
      shift
      ;;
    --versions)
      if [[ $# -lt 2 ]]; then
        echo "error: --versions requires a quoted space-separated value" >&2
        exit 2
      fi
      # shellcheck disable=SC2206
      SDK_SPECS=($2)
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$INCLUDE_FUTURE" -eq 1 ]]; then
  SDK_SPECS+=("0.70.x")
fi

copy_repo() {
  local target="$1"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.git/' \
      --exclude '.trekoon/' \
      --exclude 'node_modules/' \
      --exclude 'dist/' \
      "$ROOT_DIR/" "$target/"
  else
    (cd "$ROOT_DIR" && tar \
      --exclude './.git' \
      --exclude './.trekoon' \
      --exclude './node_modules' \
      --exclude './dist' \
      -cf - .) | (cd "$target" && tar -xf -)
  fi
}

print_plan() {
  cat <<PLAN
Pi SDK compatibility matrix
root: $ROOT_DIR
dry_run: $DRY_RUN
sdk_specs: ${SDK_SPECS[*]}

For each SDK spec, the script will:
  1. create a temporary copy of the repository outside the checkout
  2. run npm install in that copy
  3. install @mariozechner/pi-coding-agent@<spec> and @mariozechner/pi-tui@<spec> in that copy only
  4. run npm run typecheck
  5. run npm test
  6. delete the temporary copy

Future gate: pass --include-future to try 0.70.x without widening package peerDependencies.
PLAN
}

print_plan

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  for spec in "${SDK_SPECS[@]}"; do
    echo "[dry-run] SDK $spec"
    echo "[dry-run] npm install --no-audit --no-fund"
    echo "[dry-run] npm install --no-audit --no-fund --no-save @mariozechner/pi-coding-agent@$spec @mariozechner/pi-tui@$spec"
    echo "[dry-run] npm run typecheck"
    echo "[dry-run] npm test"
  done
  exit 0
fi

for spec in "${SDK_SPECS[@]}"; do
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-hooks-sdk-${spec//[^A-Za-z0-9._-]/_}.XXXXXX")"
  cleanup() {
    rm -rf "$tmp_dir"
  }
  trap cleanup EXIT

  echo
  echo "==> Checking Pi SDK $spec in $tmp_dir"
  copy_repo "$tmp_dir"

  (
    cd "$tmp_dir"
    npm install --no-audit --no-fund
    npm install --no-audit --no-fund --no-save \
      "@mariozechner/pi-coding-agent@$spec" \
      "@mariozechner/pi-tui@$spec"
    npm run typecheck
    npm test
  )

  cleanup
  trap - EXIT
  echo "==> Pi SDK $spec passed"
done

echo

echo "Pi SDK compatibility matrix passed: ${SDK_SPECS[*]}"

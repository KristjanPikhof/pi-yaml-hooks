#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
INCLUDE_FUTURE=0
SDK_SPECS=("0.74.0")

usage() {
  cat <<'USAGE'
Usage: scripts/check-sdk-matrix.sh [--dry-run] [--include-future] [--versions "<spec> [<spec>...]"]

Runs the normal pi-yaml-hooks verification suite against temporary installs of the Pi SDK
peer packages. The repository checkout, package.json, package-lock.json, and normal
node_modules are not modified; each SDK spec is installed in a throwaway copy.

Default matrix:
  - @earendil-works/pi-coding-agent@0.74.0 and @earendil-works/pi-tui@0.74.0

Options:
  --dry-run         Print the matrix and commands without creating temp installs.
  --include-future Include the gated 0.75.x future target. This is advisory only and
                   does not change package peer support.
  --versions        Override SDK specs, for example: --versions "0.74.0 0.75.x".
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
      # Use read -a to perform a controlled word-split of the user-supplied
      # space-separated specs. This avoids glob expansion and IFS surprises
      # that would happen with `SDK_SPECS=($2)`.
      read -r -a SDK_SPECS <<< "$2"
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
  SDK_SPECS+=("0.75.x")
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
  3. install @earendil-works/pi-coding-agent@<spec> and @earendil-works/pi-tui@<spec> in that copy only
  4. run npm run typecheck
  5. run npm test
  6. delete the temporary copy

Future gate: pass --include-future to try 0.75.x without widening package peerDependencies.
PLAN
}

print_plan

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  for spec in "${SDK_SPECS[@]}"; do
    echo "[dry-run] SDK $spec"
    echo "[dry-run] npm install --no-audit --no-fund"
    echo "[dry-run] npm install --no-audit --no-fund --no-save @earendil-works/pi-coding-agent@$spec @earendil-works/pi-tui@$spec"
    echo "[dry-run] npm run typecheck"
    echo "[dry-run] npm test"
  done
  exit 0
fi

for spec in "${SDK_SPECS[@]}"; do
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-yaml-hooks-sdk-${spec//[^A-Za-z0-9._-]/_}.XXXXXX")"
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
      "@earendil-works/pi-coding-agent@$spec" \
      "@earendil-works/pi-tui@$spec"
    npm run typecheck
    npm test
  )

  cleanup
  trap - EXIT
  echo "==> Pi SDK $spec passed"
done

echo

echo "Pi SDK compatibility matrix passed: ${SDK_SPECS[*]}"

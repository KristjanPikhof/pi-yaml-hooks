#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO=""
OUT_PARENT=""
NO_DB=0
RAW_PATHS=0
SUSPECT_PATHS=()

usage() {
  cat <<'EOF'
Usage: collect-diagnostics.sh --repo PATH [options]

Collect a read-only diagnostics bundle for the example atomic commit worktree daemon.
The bundle is written outside the repository and packaged as a .tar.gz archive.

Options:
  --repo PATH        Git worktree/repository to inspect (required)
  --out DIR          Parent directory for the diagnostics bundle (default: $TMPDIR or /tmp)
  --path PATH        Optional suspect path to include focused git/file context for; repeatable
  --no-db            Skip SQLite diagnostic exports and DB file metadata
  --raw-paths        Do not redact the repo path or HOME from collected text outputs
  -h, --help         Show this help

Collected data is diagnostic metadata only: pi-hooks log tail, daemon state summaries,
SQLite schema/table summaries when sqlite3 is available, branch registry metadata, git
context, and optional suspect-path context. It does not collect the full environment or
file contents. Logs/DB metadata can still include paths, branch names, commit messages,
and symlink target strings, so review the bundle before sharing.

This script is for the examples/atomic-commit-worktree-daemon example only; it is not a
built-in pi-hooks product diagnostic collector.
EOF
}

fail() {
  echo "collect-diagnostics: $*" >&2
  exit 1
}

need_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    fail "$1 requires a value"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      need_value "$@"
      REPO="$2"
      shift 2
      ;;
    --out)
      need_value "$@"
      OUT_PARENT="$2"
      shift 2
      ;;
    --path)
      need_value "$@"
      SUSPECT_PATHS+=("$2")
      shift 2
      ;;
    --no-db)
      NO_DB=1
      shift
      ;;
    --raw-paths)
      RAW_PATHS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

[[ -n "$REPO" ]] || { usage >&2; exit 1; }
command -v git >/dev/null 2>&1 || fail "git is required"

REPO_ROOT="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)" || fail "--repo is not inside a git worktree: $REPO"
GIT_DIR="$(git -C "$REPO_ROOT" rev-parse --absolute-git-dir)" || fail "unable to resolve git dir"
COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir)" || fail "unable to resolve git common dir"
case "$COMMON_DIR" in
  /*) ;;
  *) COMMON_DIR="$(cd "$REPO_ROOT" && cd "$COMMON_DIR" && pwd)" ;;
esac
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
GIT_DIR="$(cd "$GIT_DIR" && pwd)"
COMMON_DIR="$(cd "$COMMON_DIR" && pwd)"

if [[ -z "$OUT_PARENT" ]]; then
  OUT_PARENT="${TMPDIR:-/tmp}"
fi
mkdir -p "$OUT_PARENT"
OUT_PARENT="$(cd "$OUT_PARENT" && pwd)"
case "$OUT_PARENT/" in
  "$REPO_ROOT"/*|"$GIT_DIR"/*|"$COMMON_DIR"/*)
    fail "--out must be outside the repository/git state: $OUT_PARENT"
    ;;
esac

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SAFE_REPO_NAME="$(basename "$REPO_ROOT" | tr -c 'A-Za-z0-9._-' '_')"
BUNDLE_DIR="$OUT_PARENT/pi-hooks-atomic-daemon-diagnostics-${SAFE_REPO_NAME}-${STAMP}"
mkdir "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"/{git,pi-hooks,daemon,sqlite,branch-registry,suspect-paths}

run_capture() {
  local outfile="$1"
  shift
  {
    echo "$ $*"
    "$@"
  } >"$outfile" 2>&1 || true
}

redact_file() {
  local file="$1"
  [[ "$RAW_PATHS" -eq 0 ]] || return 0
  [[ -f "$file" ]] || return 0
  local tmp="${file}.redact.$$"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" "$tmp" "$REPO_ROOT" "$GIT_DIR" "$COMMON_DIR" "${HOME:-}" <<'PY'
import sys
src, dst, repo, git_dir, common_dir, home = sys.argv[1:7]
replacements = [(repo, "<repo>"), (git_dir, "<git-dir>"), (common_dir, "<git-common-dir>")]
if home:
    replacements.append((home, "<home>"))
with open(src, "r", encoding="utf-8", errors="replace") as fh:
    data = fh.read()
for old, new in replacements:
    if old:
        data = data.replace(old, new)
with open(dst, "w", encoding="utf-8") as fh:
    fh.write(data)
PY
    mv "$tmp" "$file"
  else
    sed -e "s|$REPO_ROOT|<repo>|g" -e "s|$GIT_DIR|<git-dir>|g" -e "s|$COMMON_DIR|<git-common-dir>|g" -e "s|${HOME:-__NO_HOME__}|<home>|g" "$file" >"$tmp" && mv "$tmp" "$file"
  fi
}

write_note() {
  cat >"$BUNDLE_DIR/README.txt" <<EOF
Atomic commit worktree daemon example diagnostics bundle

Created UTC: $STAMP
Collector: $SCRIPT_DIR/collect-diagnostics.sh
Example-only scope: this targets examples/atomic-commit-worktree-daemon and is not a built-in pi-hooks product diagnostic collector.
Read-only intent: the collector writes only under this bundle directory and runs git/sqlite read commands against the target repo.
Repo path redaction: $([[ "$RAW_PATHS" -eq 1 ]] && echo disabled || echo enabled)
SQLite exports: $([[ "$NO_DB" -eq 1 ]] && echo skipped_by_flag || echo attempted_if_sqlite3_available)

Privacy notes:
- pi-hooks logs, daemon database rows, branch registry files, git output, and symlink metadata can contain paths, branch names, commit messages, error strings, and symlink target strings.
- This collector does not collect the full process environment, shell history, file contents, or untracked file contents.
- Default redaction replaces the absolute repo, git-dir, git-common-dir, and HOME paths in text outputs. It does not guarantee removal of branch names, commit messages, relative paths, or secrets already present in logs/errors.
- Review the bundle before sharing it outside your machine or organization.
EOF
}

write_manifest() {
  cat >"$BUNDLE_DIR/manifest.txt" <<EOF
repo_root=$([[ "$RAW_PATHS" -eq 1 ]] && printf '%s' "$REPO_ROOT" || printf '<repo>')
git_dir=$([[ "$RAW_PATHS" -eq 1 ]] && printf '%s' "$GIT_DIR" || printf '<git-dir>')
git_common_dir=$([[ "$RAW_PATHS" -eq 1 ]] && printf '%s' "$COMMON_DIR" || printf '<git-common-dir>')
collector_script=$SCRIPT_DIR/collect-diagnostics.sh
snapshot_daemonctl=$SCRIPT_DIR/snapshot-daemonctl.py
snapshot_daemon=$SCRIPT_DIR/snapshot-daemon.py
raw_paths=$RAW_PATHS
no_db=$NO_DB
EOF
}

collect_git_context() {
  run_capture "$BUNDLE_DIR/git/rev-parse.txt" git -C "$REPO_ROOT" rev-parse --show-toplevel --absolute-git-dir --git-common-dir --is-bare-repository --is-inside-work-tree --abbrev-ref HEAD HEAD
  run_capture "$BUNDLE_DIR/git/status-short.txt" git -C "$REPO_ROOT" status --short --branch --untracked-files=normal
  run_capture "$BUNDLE_DIR/git/worktree-list.txt" git -C "$REPO_ROOT" worktree list --porcelain
  run_capture "$BUNDLE_DIR/git/recent-commits.txt" git -C "$REPO_ROOT" log --oneline --decorate --max-count=30
  redact_file "$BUNDLE_DIR/git/rev-parse.txt"
  redact_file "$BUNDLE_DIR/git/status-short.txt"
  redact_file "$BUNDLE_DIR/git/worktree-list.txt"
  redact_file "$BUNDLE_DIR/git/recent-commits.txt"
}

collect_pi_hooks_logs() {
  local log_file="${PI_HOOKS_LOG_FILE:-$HOME/.pi/agent/logs/pi-hooks.ndjson}"
  {
    echo "log_file=$([[ "$RAW_PATHS" -eq 1 ]] && printf '%s' "$log_file" || printf '<pi-hooks-log>')"
    if [[ -f "$log_file" ]]; then
      echo "--- tail -n 1000 ---"
      tail -n 1000 "$log_file"
    else
      echo "pi-hooks log file not found"
    fi
  } >"$BUNDLE_DIR/pi-hooks/pi-hooks-log-tail.ndjson"
  redact_file "$BUNDLE_DIR/pi-hooks/pi-hooks-log-tail.ndjson"
}

collect_daemon_state() {
  local state_dir="$GIT_DIR/ai-snapshotd"
  {
    echo "state_dir=$([[ "$RAW_PATHS" -eq 1 ]] && printf '%s' "$state_dir" || printf '<git-dir>/ai-snapshotd')"
    echo "daemonctl=$SCRIPT_DIR/snapshot-daemonctl.py"
    echo "daemonctl_status_note=not invoked because snapshot-daemonctl.py status opens/initializes the DB; this collector stays read-only"
    if [[ -d "$state_dir" ]]; then
      find "$state_dir" -maxdepth 1 -mindepth 1 -printf '%M %u %g %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n' 2>/dev/null || ls -la "$state_dir"
    else
      echo "state dir not found"
    fi
  } >"$BUNDLE_DIR/daemon/state-files.txt"
  redact_file "$BUNDLE_DIR/daemon/state-files.txt"

  if [[ -f "$SCRIPT_DIR/snapshot-daemonctl.py" ]]; then
    python3 "$SCRIPT_DIR/snapshot-daemonctl.py" --help >"$BUNDLE_DIR/daemon/snapshot-daemonctl-help.txt" 2>&1 || true
  fi
}

collect_sqlite() {
  [[ "$NO_DB" -eq 0 ]] || { echo "SQLite export skipped by --no-db" >"$BUNDLE_DIR/sqlite/skipped.txt"; return 0; }
  local db="$GIT_DIR/ai-snapshotd/daemon.db"
  if [[ ! -f "$db" ]]; then
    echo "daemon.db not found" >"$BUNDLE_DIR/sqlite/not-found.txt"
    return 0
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "sqlite3 not found on PATH; SQLite exports skipped" >"$BUNDLE_DIR/sqlite/sqlite3-missing.txt"
    return 0
  fi

  run_capture "$BUNDLE_DIR/sqlite/schema.txt" sqlite3 -readonly "$db" .schema
  sqlite3 -readonly "$db" <<'SQL' >"$BUNDLE_DIR/sqlite/table-counts.tsv" 2>&1 || true
.headers on
.mode tabs
SELECT 'daemon_state' AS table_name, count(*) AS rows FROM daemon_state
UNION ALL SELECT 'capture_events', count(*) FROM capture_events
UNION ALL SELECT 'capture_ops', count(*) FROM capture_ops
UNION ALL SELECT 'flush_requests', count(*) FROM flush_requests
UNION ALL SELECT 'publish_state', count(*) FROM publish_state
UNION ALL SELECT 'shadow_paths', count(*) FROM shadow_paths;
SQL
  sqlite3 -readonly "$db" <<'SQL' >"$BUNDLE_DIR/sqlite/daemon-state.json" 2>&1 || true
.mode json
SELECT * FROM daemon_state LIMIT 1;
SQL
  sqlite3 -readonly "$db" <<'SQL' >"$BUNDLE_DIR/sqlite/publish-state.json" 2>&1 || true
.mode json
SELECT * FROM publish_state LIMIT 1;
SQL
  sqlite3 -readonly "$db" <<'SQL' >"$BUNDLE_DIR/sqlite/recent-capture-events.json" 2>&1 || true
.mode json
SELECT seq, branch_ref, branch_generation, base_head, operation, path, old_path, fidelity, captured_ts, published_ts, state, commit_oid, error, message
FROM capture_events
ORDER BY seq DESC
LIMIT 100;
SQL
  sqlite3 -readonly "$db" <<'SQL' >"$BUNDLE_DIR/sqlite/recent-flush-requests.json" 2>&1 || true
.mode json
SELECT * FROM flush_requests ORDER BY id DESC LIMIT 100;
SQL
  redact_file "$BUNDLE_DIR/sqlite/schema.txt"
  redact_file "$BUNDLE_DIR/sqlite/table-counts.tsv"
  redact_file "$BUNDLE_DIR/sqlite/daemon-state.json"
  redact_file "$BUNDLE_DIR/sqlite/publish-state.json"
  redact_file "$BUNDLE_DIR/sqlite/recent-capture-events.json"
  redact_file "$BUNDLE_DIR/sqlite/recent-flush-requests.json"
}

collect_branch_registry() {
  local reg_dir="$COMMON_DIR/ai-snapshotd/branch-registry"
  {
    echo "registry_dir=$([[ "$RAW_PATHS" -eq 1 ]] && printf '%s' "$reg_dir" || printf '<git-common-dir>/ai-snapshotd/branch-registry')"
    if [[ -d "$reg_dir" ]]; then
      find "$reg_dir" -maxdepth 1 -type f -print | sort | while IFS= read -r f; do
        echo "--- $f ---"
        if [[ "$f" == *.json ]]; then
          head -c 20000 "$f"; echo
        else
          ls -l "$f"
        fi
      done
    else
      echo "branch registry not found"
    fi
  } >"$BUNDLE_DIR/branch-registry/registry.txt"
  redact_file "$BUNDLE_DIR/branch-registry/registry.txt"
}

collect_suspect_paths() {
  local idx=0
  for p in "${SUSPECT_PATHS[@]}"; do
    idx=$((idx + 1))
    local file="$BUNDLE_DIR/suspect-paths/path-${idx}.txt"
    {
      echo "path=$p"
      echo
      echo "## git status"
      git -C "$REPO_ROOT" status --short -- "$p" 2>&1 || true
      echo
      echo "## git ls-files --stage"
      git -C "$REPO_ROOT" ls-files --stage -- "$p" 2>&1 || true
      echo
      echo "## recent path commits"
      git -C "$REPO_ROOT" log --oneline --decorate --max-count=20 -- "$p" 2>&1 || true
      echo
      echo "## filesystem metadata"
      if [[ -e "$REPO_ROOT/$p" || -L "$REPO_ROOT/$p" ]]; then
        ls -ld "$REPO_ROOT/$p" 2>&1 || true
        if [[ -L "$REPO_ROOT/$p" ]]; then
          printf 'symlink_target='; readlink "$REPO_ROOT/$p" 2>&1 || true
        elif [[ -f "$REPO_ROOT/$p" ]]; then
          if command -v shasum >/dev/null 2>&1; then
            shasum -a 256 "$REPO_ROOT/$p" 2>&1 || true
          elif command -v sha256sum >/dev/null 2>&1; then
            sha256sum "$REPO_ROOT/$p" 2>&1 || true
          fi
        fi
      else
        echo "path absent in worktree"
      fi
    } >"$file"
    redact_file "$file"
  done
}

write_note
write_manifest
collect_git_context
collect_pi_hooks_logs
collect_daemon_state
collect_sqlite
collect_branch_registry
collect_suspect_paths

# Redact manifest/README after creation too, in case the script path lives under HOME.
redact_file "$BUNDLE_DIR/README.txt"
redact_file "$BUNDLE_DIR/manifest.txt"

TARBALL="${BUNDLE_DIR}.tar.gz"
tar -C "$OUT_PARENT" -czf "$TARBALL" "$(basename "$BUNDLE_DIR")"

printf 'Diagnostics bundle: %s\n' "$BUNDLE_DIR"
printf 'Diagnostics tarball: %s\n' "$TARBALL"
printf 'Review README.txt privacy notes before sharing.\n'

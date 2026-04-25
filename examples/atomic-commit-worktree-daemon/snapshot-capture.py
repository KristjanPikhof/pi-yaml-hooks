#!/usr/bin/env python3
"""Portable capture backend for the worktree daemon example.

The first implementation uses polling/rescan only. It seeds a shadow tree on
startup, compares the live worktree against the stored shadow on each poll, and
records stable file events with ``rescan`` fidelity.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import subprocess
import stat
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import snapshot_state  # noqa: E402


IGNORE_NAMES = {".git", snapshot_state.STATE_SUBDIR}
# Canonical default list lives in snapshot_state.DEFAULT_SENSITIVE_GLOBS so the
# fast-path filter here and the defence-in-depth guard inside capture_blob_*
# can never drift. SNAPSHOTD_SENSITIVE_GLOBS overrides at runtime.


def _mode_for_stat(st: os.stat_result) -> str:
    if stat.S_ISLNK(st.st_mode):
        return "120000"
    if st.st_mode & stat.S_IXUSR:
        return "100755"
    return "100644"


def _read_path_bytes(path: Path) -> bytes:
    if path.is_symlink():
        return os.readlink(path).encode("utf-8")
    return path.read_bytes()


def _is_git_ignored(repo_root: Path, rel: str) -> bool:
    proc = subprocess.run(
        ["git", "check-ignore", "-q", "--", rel],
        cwd=str(repo_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=snapshot_state._clean_git_env(),
    )
    return proc.returncode == 0


def _is_sensitive(rel: str) -> bool:
    return snapshot_state.is_sensitive_path(rel)


def _scan_tree(repo_root: Path) -> Dict[str, Dict[str, Any]]:
    entries: Dict[str, Dict[str, Any]] = {}
    for root, dirs, files in os.walk(repo_root, topdown=True, followlinks=False):
        root_path = Path(root)
        dirs[:] = [name for name in dirs if name not in IGNORE_NAMES]
        for name in files:
            if name in IGNORE_NAMES:
                continue
            path = root_path / name
            try:
                st = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(st.st_mode):
                continue
            rel = path.relative_to(repo_root).as_posix()
            if _is_sensitive(rel) or _is_git_ignored(repo_root, rel):
                continue
            try:
                data = _read_path_bytes(path)
            except FileNotFoundError:
                continue
            entries[rel] = {
                "path": rel,
                "mode": _mode_for_stat(st),
                "oid": snapshot_state.capture_blob_for_bytes(repo_root, data),
            }
    return entries


def bootstrap_shadow(
    conn,
    repo_root: Path,
    *,
    branch_ref: str,
    branch_generation: int,
    base_head: str,
) -> int:
    if snapshot_state.get_daemon_meta(conn, "shadow_bootstrapped") == "1":
        return 0
    live = _scan_tree(repo_root)
    snapshot_state.replace_shadow_paths(
        conn,
        branch_ref=branch_ref,
        branch_generation=branch_generation,
        base_head=base_head,
        entries=(
            {
                "path": row["path"],
                "operation": "baseline",
                "mode": row["mode"],
                "oid": row["oid"],
                "fidelity": "rescan",
            }
            for row in live.values()
        ),
    )
    snapshot_state.set_daemon_meta(conn, "shadow_bootstrapped", "1")
    return len(live)


def _shadow_map(conn) -> Dict[str, Dict[str, Any]]:
    return snapshot_state.load_shadow_paths(conn)


def _classify_changes(
    shadow: Dict[str, Dict[str, Any]],
    live: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    deletes = [shadow[path] for path in shadow.keys() - live.keys()]
    creates = [live[path] for path in live.keys() - shadow.keys()]
    updates: List[Dict[str, Any]] = []

    paired_creates: set[str] = set()
    paired_deletes: set[str] = set()
    create_by_sig: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for entry in creates:
        create_by_sig.setdefault((entry["oid"], entry["mode"]), []).append(entry)

    for old in deletes:
        sig = (old.get("oid") or "", old.get("mode") or "")
        matches = create_by_sig.get(sig, [])
        if len(matches) == 1 and matches[0]["path"] not in paired_creates:
            new = matches[0]
            paired_creates.add(new["path"])
            paired_deletes.add(old["path"])
            updates.append(
                {
                    "op": "rename",
                    "path": new["path"],
                    "old_path": old["path"],
                    "before_oid": old.get("oid"),
                    "before_mode": old.get("mode"),
                    "after_oid": new.get("oid"),
                    "after_mode": new.get("mode"),
                    "fidelity": "rescan",
                }
            )

    for path, live_entry in sorted(live.items()):
        shadow_entry = shadow.get(path)
        if shadow_entry is None:
            if path not in paired_creates:
                updates.append(
                    {
                        "op": "create",
                        "path": path,
                        "before_oid": None,
                        "before_mode": None,
                        "after_oid": live_entry["oid"],
                        "after_mode": live_entry["mode"],
                        "fidelity": "rescan",
                    }
                )
            continue
        if shadow_entry.get("oid") != live_entry.get("oid"):
            updates.append(
                {
                    "op": "modify",
                    "path": path,
                    "before_oid": shadow_entry.get("oid"),
                    "before_mode": shadow_entry.get("mode"),
                    "after_oid": live_entry.get("oid"),
                    "after_mode": live_entry.get("mode"),
                    "fidelity": "rescan",
                }
            )
        elif shadow_entry.get("mode") != live_entry.get("mode"):
            updates.append(
                {
                    "op": "mode",
                    "path": path,
                    "before_oid": shadow_entry.get("oid"),
                    "before_mode": shadow_entry.get("mode"),
                    "after_oid": live_entry.get("oid"),
                    "after_mode": live_entry.get("mode"),
                    "fidelity": "rescan",
                }
            )

    for old in sorted(deletes, key=lambda row: row["path"]):
        if old["path"] in paired_deletes:
            continue
        updates.append(
            {
                "op": "delete",
                "path": old["path"],
                "before_oid": old.get("oid"),
                "before_mode": old.get("mode"),
                "after_oid": None,
                "after_mode": None,
                "fidelity": "rescan",
            }
        )

    return updates


def _apply_event(conn, ctx: Dict[str, Any], event: Dict[str, Any]) -> int:
    return snapshot_state.record_event(
        conn,
        branch_ref=ctx["branch_ref"],
        branch_generation=ctx["branch_generation"],
        base_head=ctx["base_head"],
        operation=event["op"],
        path=event["path"],
        old_path=event.get("old_path"),
        fidelity=event.get("fidelity", "rescan"),
        ops=[event],
    )


def poll_once(conn, repo_root: Path, git_dir: Path) -> List[int]:
    ctx = snapshot_state.repo_context(repo_root, git_dir)
    bootstrap_shadow(
        conn,
        repo_root,
        branch_ref=ctx["branch_ref"],
        branch_generation=ctx["branch_generation"],
        base_head=ctx["base_head"],
    )
    shadow = _shadow_map(conn)
    live = _scan_tree(repo_root)
    events = _classify_changes(shadow, live)
    seqs: List[int] = []
    for event in events:
        seqs.append(_apply_event(conn, ctx, event))
    return seqs


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Poll the worktree and record rescan events")
    parser.add_argument("--repo", default=os.getcwd(), help="repo working directory")
    parser.add_argument("--git-dir", help="explicit git dir override")
    parser.add_argument("--once", action="store_true", help="perform one rescan and exit")
    args = parser.parse_args(argv)

    repo_input = Path(args.repo).expanduser()
    try:
        repo_root, git_dir, _common = snapshot_state.resolve_repo_paths(repo_input)
        if args.git_dir:
            git_dir = Path(args.git_dir).expanduser().resolve()
    except Exception as exc:
        print(f"not a git repository: {exc}", file=sys.stderr)
        return 1

    conn = snapshot_state.ensure_state(git_dir)
    try:
        if args.once:
            print(json.dumps({"published": poll_once(conn, repo_root, git_dir)}, sort_keys=True))
            return 0
        ctx = snapshot_state.repo_context(repo_root, git_dir)
        print(
            json.dumps(
                {
                    "scanned": bootstrap_shadow(
                        conn,
                        repo_root,
                        branch_ref=ctx["branch_ref"],
                        branch_generation=ctx["branch_generation"],
                        base_head=ctx["base_head"],
                    )
                },
                sort_keys=True,
            )
        )
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

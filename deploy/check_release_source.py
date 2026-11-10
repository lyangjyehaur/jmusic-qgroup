#!/usr/bin/env python3
"""Validate an explicit production source against freshly fetched origin/main."""

import argparse
from pathlib import Path
import re
import subprocess
import sys


def git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args],
        check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True, help="full 40-character commit SHA")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-fA-F]{40}", args.commit):
        parser.error("--commit must be a full 40-character commit SHA, not a branch or HEAD")
    root = Path(__file__).resolve().parent.parent
    try:
        if git(root, "status", "--porcelain", "--untracked-files=normal"):
            raise ValueError("working tree is not clean; commit or preserve drafts first")
        # Refresh explicitly: a stale local origin/main cannot authorize a release.
        git(root, "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main")
        remote_main = git(root, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}")
        commit = git(root, "rev-parse", "--verify", args.commit + "^{commit}")
        git(root, "merge-base", "--is-ancestor", commit, remote_main)
    except (subprocess.CalledProcessError, ValueError) as exc:
        detail = exc.stderr.strip() if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        print("Release source rejected: " + (detail or "commit is not in remote origin/main history"), file=sys.stderr)
        return 1
    print(commit)
    return 0


if __name__ == "__main__":
    sys.exit(main())

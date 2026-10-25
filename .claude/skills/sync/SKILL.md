---
name: sync
description: After the maintainer merges a PR on GitHub, return to an up-to-date main and clean up the merged branch. Use when the user says /sync, "ОК ЖАБА", "merged", "смержил", or otherwise signals that a PR was merged in the croak repo.
---

# Sync: back to a fresh main

1. Note the current branch: `git branch --show-current`.
2. If there are uncommitted changes (`git status --short`), stop and ask — never discard work.
3. Confirm the PR is merged: `gh pr view <branch> --json state,mergedAt`.
   - Not merged: tell the user and stop.
4. `git switch main && git pull --ff-only`.
   - If fast-forward fails, stop and report; do not reset or rebase without asking.
5. `git fetch --prune`.
6. Delete the merged local branch:
   - `git branch -d <branch>`.
   - If `-d` refuses (squash or rebase merge makes the branch look unmerged) and step 3
     confirmed `MERGED`, use `git branch -D <branch>`.
7. Report: current branch, latest commit (`git log --oneline -3`), and the next step
   from ROADMAP.md.

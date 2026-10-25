#!/bin/sh
# Fetch the real-world corpus (eval/corpus.json) at pinned commits into the
# gitignored eval/corpus/repos/. Fetching lives outside croak's code on
# purpose: croak never spawns processes (D4, invariants).
#
# Hardening: shallow fetch of one commit, no submodules, no hooks, and Git LFS
# filters disabled so checkout runs no filter commands.
set -eu
cd "$(dirname "$0")/.."
DEST=eval/corpus/repos
mkdir -p "$DEST"

node -e 'for (const r of JSON.parse(require("fs").readFileSync("eval/corpus.json","utf8")).repos) console.log(r.name, r.repo, r.commit)' |
while read -r name repo commit; do
  # corpus.json is data from the repo (and from PRs once public): validate it
  # before it reaches rm -rf, a URL, or a git argument.
  case "$name" in ''|*[!a-z0-9-]*) echo "invalid corpus name: $name" >&2; exit 1 ;; esac
  echo "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || { echo "invalid repo: $repo" >&2; exit 1; }
  echo "$commit" | grep -Eq '^[0-9a-f]{40}$' || { echo "invalid commit: $commit" >&2; exit 1; }
  dir="$DEST/$name"
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$commit" ]; then
    echo "ok      $name"
    continue
  fi
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" -c core.hooksPath=/dev/null fetch -q --depth 1 --no-recurse-submodules \
    "https://github.com/$repo.git" "$commit"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$dir" \
    -c core.hooksPath=/dev/null -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false \
    checkout -q FETCH_HEAD
  echo "fetched $name"
done

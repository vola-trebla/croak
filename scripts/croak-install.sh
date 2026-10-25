#!/bin/sh
# croak-install <package...> — plan an npm install without running it, then
# let croak judge the plan. croak itself never spawns processes; this wrapper
# is the one place that runs npm, and it isolates it (D24):
#   - a fresh temporary directory with copies of package.json and the lockfile
#     only (no project .npmrc); the project's own files are never modified
#   - an empty environment and empty npm user/global config (no auth tokens)
#   - the public registry only; git disabled, so git dependencies fail closed
#   - --package-lock-only --ignore-scripts: npm resolves, nothing is installed
# npm still talks to the network and parses registry metadata: this is
# isolation, not a sandbox.
set -eu

usage() { echo "usage: croak-install <package> [package...]" >&2; exit 2; }
[ "$#" -gt 0 ] || usage
for arg in "$@"; do
  case "$arg" in -*) echo "croak-install: npm flags are not passed through: $arg" >&2; exit 2 ;; esac
done
[ -f package.json ] || { echo "croak-install: no package.json here; run it in a project directory" >&2; exit 2; }

self=$(realpath "$0" 2>/dev/null || echo "$0")
cli="$(dirname "$self")/../dist/cli.js"
[ -f "$cli" ] || { echo "croak-install: $cli not found (run pnpm build in the croak repo)" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/croak-install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
cp package.json "$work/package.json"
before=none
if [ -f package-lock.json ]; then
  cp package-lock.json "$work/package-lock.json"
  cp package-lock.json "$work/before.json"
  before="$work/before.json"
fi
mkdir "$work/home"
: >"$work/user.npmrc"
: >"$work/global.npmrc"

if ! (cd "$work" && env -i PATH="$PATH" HOME="$work/home" \
  npm_config_userconfig="$work/user.npmrc" npm_config_globalconfig="$work/global.npmrc" \
  npm_config_cache="$work/cache" npm_config_registry="https://registry.npmjs.org/" \
  npm_config_git=/usr/bin/false npm_config_ignore_scripts=true \
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund -- "$@" >"$work/npm.log" 2>&1); then
  echo "croak-install: npm could not plan this install, so it was not checked:" >&2
  tail -n 15 "$work/npm.log" >&2
  exit 3
fi

node "$cli" plan --before "$before" --after "$work/package-lock.json"

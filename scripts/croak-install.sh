#!/bin/sh
# croak-install [package...] — plan an npm install without running it, then
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

usage() { echo "usage: croak-install [--json] [--ci | --empty] [package...]" >&2; exit 2; }
# Modes, for people and for the agent hook (D32):
#   (default)  npm install [package...] in this project; no packages = what
#              package.json lists
#   --ci       npm ci: the lockfile exactly as written, every package fresh
#   --empty    an install into an empty project (npx, npm install -g)
# "Before" is what is installed now (node_modules/.package-lock.json, which
# npm maintains), not the project's lockfile: on a fresh clone npm installs,
# and runs the scripts of, everything the lockfile lists.
json=""
mode=project
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) json=--json; shift ;;
    --ci) mode=ci; shift ;;
    --empty) mode=empty; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
for arg in "$@"; do
  case "$arg" in -*) echo "croak-install: npm flags are not passed through: $arg" >&2; exit 2 ;; esac
done
case "$mode" in
  ci) [ "$#" -eq 0 ] || usage
      [ -f package-lock.json ] || { echo "croak-install: npm ci needs a package-lock.json here" >&2; exit 2; } ;;
  empty) [ "$#" -gt 0 ] || usage ;;
  project) [ -f package.json ] || { echo "croak-install: no package.json here; run it in a project directory" >&2; exit 2; } ;;
esac

self=$(realpath "$0" 2>/dev/null || echo "$0")
cli="$(dirname "$self")/../dist/cli.js"
[ -f "$cli" ] || { echo "croak-install: $cli not found (run pnpm build in the croak repo)" >&2; exit 2; }

if [ "$mode" = ci ]; then
  # npm ci removes node_modules and installs the lockfile as is: nothing to plan.
  exec node "$cli" plan --before none --after package-lock.json $json
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/croak-install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
before=none
if [ "$mode" = empty ]; then
  echo '{ "name": "croak-empty", "version": "0.0.0", "private": true }' >"$work/package.json"
else
  cp package.json "$work/package.json"
  [ ! -f package-lock.json ] || cp package-lock.json "$work/package-lock.json"
  if [ -f node_modules/.package-lock.json ]; then
    cp node_modules/.package-lock.json "$work/before.json"
    before="$work/before.json"
  fi
fi
mkdir "$work/home"
: >"$work/user.npmrc"
: >"$work/global.npmrc"

if ! (cd "$work" && env -i PATH="$PATH" HOME="$work/home" \
  npm_config_userconfig="$work/user.npmrc" npm_config_globalconfig="$work/global.npmrc" \
  npm_config_cache="$work/cache" npm_config_registry="https://registry.npmjs.org/" \
  npm_config_git=/usr/bin/false npm_config_ignore_scripts=true \
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund -- "$@" >"$work/npm.log" 2>&1); then
  if grep -q "E404" "$work/npm.log"; then
    # Most often a mistyped or AI-invented name; an attacker may register it later.
    echo "croak-install: a requested package does not exist on npm. Check the name:" >&2
    echo "AI agents often invent plausible package names, and attackers register them." >&2
    grep -E "404|is not in this registry" "$work/npm.log" | head -n 3 >&2
    exit 2
  fi
  echo "croak-install: npm could not plan this install, so it was not checked:" >&2
  tail -n 15 "$work/npm.log" >&2
  exit 3
fi

node "$cli" plan --before "$before" --after "$work/package-lock.json" $json

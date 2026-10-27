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

usage() { echo "usage: croak-install [--json] [--ci | --update | --empty] [package...]" >&2; exit 2; }
# Modes, for people and for the agent hook (D32):
#   (default)  npm install [package...] in this project; no packages = what
#              package.json lists
#   --ci       npm ci: the lockfile exactly as written, every package fresh
#   --update   npm update [package...]: the newest versions in range
#   --empty    an install into an empty project (npx, npm install -g)
# "Before" is what is installed now: node_modules/.package-lock.json, keeping
# only entries whose folder really holds that package (croak plan
# --installed), not the project's lockfile. On a fresh clone npm installs,
# and runs the scripts of, everything the lockfile lists.
json=""
mode=project
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) json=--json; shift ;;
    --ci) mode=ci; shift ;;
    --update) mode=update; shift ;;
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
  project | update) [ -f package.json ] || { echo "croak-install: no package.json here; run it in a project directory" >&2; exit 2; } ;;
esac

# Not checked yet (D34): fail closed instead of checking a different install.
if [ "$mode" != empty ]; then
  [ ! -f npm-shrinkwrap.json ] || { echo "croak-install: npm-shrinkwrap.json is not supported yet, so this install was not checked" >&2; exit 2; }
  dir=$(pwd -P)
  while :; do
    if [ -f "$dir/package.json" ] && grep -q '"workspaces"[[:space:]]*:' "$dir/package.json"; then
      echo "croak-install: $dir uses npm workspaces, which croak does not check yet" >&2
      exit 2
    fi
    [ "$dir" != / ] || break
    dir=$(dirname "$dir")
  done
fi

self=$(realpath "$0" 2>/dev/null || echo "$0")
root=$(cd "$(dirname "$self")/.." && pwd -P)
cli="$root/dist/cli.js"
[ -f "$cli" ] || { echo "croak-install: $cli not found (run pnpm build in the croak repo)" >&2; exit 2; }

# croak runs sandboxed (D23, D33): it may read croak itself, the plan's files
# and this project, and write only its cache; spawning, workers and eval are
# denied. The network is not covered by Node's permission model.
cache="${XDG_CACHE_HOME:-$HOME/.cache}/croak/content"
# Each flag is one quoted word: a cache path with a space must never split
# into a second argument that node would run as a script. Without a usable
# cache, both repeat the croak read grant, which changes nothing.
cache_read="--allow-fs-read=$root"
cache_write="--allow-fs-read=$root"
if mkdir -p "$cache" 2>/dev/null && chmod 700 "$cache" 2>/dev/null; then
  real_cache=$(cd "$cache" && pwd -P)
  cache_read="--allow-fs-read=$real_cache"
  cache_write="--allow-fs-write=$real_cache"
fi
project=$(pwd -P)
# CROAK_LLM=1 adds the opt-in LLM step (D36): Claude Haiku 5.5 on packages
# the rules only warned about. It needs ANTHROPIC_API_KEY in the environment.
llm=""
[ "${CROAK_LLM:-}" != 1 ] || llm=--llm
croak() { # croak <extra read path> <args...>
  extra=$1
  shift
  node --permission --allow-fs-read="$root" --allow-fs-read="$project" --allow-fs-read="$extra" \
    "$cache_read" "$cache_write" --disallow-code-generation-from-strings "$cli" "$@"
}

if [ "$mode" = ci ]; then
  # npm ci removes node_modules and installs the lockfile as is: nothing to plan.
  croak "$project" plan --before none --after package-lock.json --project "$project" $json $llm
  exit $?
fi

# The real path: Node's permission model checks resolved paths (/var → /private/var).
work=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/croak-install.XXXXXX")" && pwd -P)
trap 'rm -rf "$work"' EXIT INT TERM
if [ "$mode" = empty ]; then
  echo '{ "name": "croak-empty", "version": "0.0.0", "private": true }' >"$work/package.json"
  baseline=--before baseline_value=none
else
  cp package.json "$work/package.json"
  [ ! -f package-lock.json ] || cp package-lock.json "$work/package-lock.json"
  baseline=--installed baseline_value=$project
fi
npm_command=install
[ "$mode" != update ] || npm_command=update
mkdir "$work/home"
: >"$work/user.npmrc"
: >"$work/global.npmrc"

if ! (cd "$work" && env -i PATH="$PATH" HOME="$work/home" \
  npm_config_userconfig="$work/user.npmrc" npm_config_globalconfig="$work/global.npmrc" \
  npm_config_cache="$work/cache" npm_config_registry="https://registry.npmjs.org/" \
  npm_config_git=/usr/bin/false npm_config_ignore_scripts=true \
  npm "$npm_command" --package-lock-only --ignore-scripts --no-audit --no-fund -- "$@" >"$work/npm.log" 2>&1); then
  if grep -q "E404" "$work/npm.log"; then
    # Most often a mistyped or AI-invented name; an attacker may register it later.
    echo "croak-install: a requested package does not exist on npm. Check the name:" >&2
    echo "AI agents often invent plausible package names, and attackers register them." >&2
    grep -E "404|is not in this registry" "$work/npm.log" | head -n 3 >&2
    missing=$(sed -n 's#.*404 Not Found - GET https://registry.npmjs.org/\([^ ]*\).*#\1#p' "$work/npm.log" | sort -u)
    # shellcheck disable=SC2086 # one registry path per word, from npm's own log
    set -f
    [ -z "$missing" ] || croak "$work" suggest $missing >&2
    set +f
    exit 2
  fi
  echo "croak-install: npm could not plan this install, so it was not checked:" >&2
  tail -n 15 "$work/npm.log" >&2
  exit 3
fi

# A plain npm install also runs the project's own install scripts (D35).
if [ "$mode" = project ] && [ "$#" -eq 0 ]; then
  croak "$work" plan "$baseline" "$baseline_value" --after "$work/package-lock.json" --project "$project" $json $llm
else
  croak "$work" plan "$baseline" "$baseline_value" --after "$work/package-lock.json" $json $llm
fi

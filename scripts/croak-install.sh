#!/bin/sh
# croak-install [--pnpm] [package...] — plan an npm or pnpm install without
# running it, then let croak judge the plan. croak itself never spawns
# processes; this wrapper is the one place that runs a package manager, and
# it isolates it (D24, D38):
#   - a fresh temporary directory with copies of the project's manifests and
#     lockfile only (no .npmrc); the project's own files are never modified
#   - an empty environment and empty package-manager config (no auth tokens)
#   - the public registry only; git replaced by a stub that fails, so git
#     dependencies fail closed
#   - --package-lock-only / --lockfile-only with --ignore-scripts: the package
#     manager resolves, nothing is installed
#   - for pnpm, which can run code before resolving: the root manifest loses
#     packageManager/devEngines (corepack would fetch and run that version)
#     and pnpm-workspace.yaml keeps only resolution settings (no pnpmfiles,
#     config dependencies or registries), both through `croak sanitize`;
#     corepack may not download anything
# The package manager still talks to the network and parses registry
# metadata: this is isolation, not a sandbox.
set -eu

usage() { echo "usage: croak-install [--pnpm] [--json] [--ci | --update | --empty] [package...]" >&2; exit 2; }
# Modes, for people and for the agent hook (D32):
#   (default)  install [package...] in this project; no packages = what
#              package.json lists
#   --ci       npm ci / pnpm install --frozen-lockfile: the lockfile as written
#   --update   update [package...]: the newest versions in range
#   --empty    an install into an empty project (npx, pnpm dlx, -g)
# "Before" is what is installed now, verified folder by folder (croak plan
# --installed), not the project's lockfile. In a workspace, the plan is made
# at the workspace root, where the package manager installs (D38).
json=""
mode=project
manager=npm
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) json=--json; shift ;;
    --pnpm) manager=pnpm; shift ;;
    --ci) mode=ci; shift ;;
    --update) mode=update; shift ;;
    --empty) mode=empty; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
for arg in "$@"; do
  case "$arg" in -*) echo "croak-install: package-manager flags are not passed through: $arg" >&2; exit 2 ;; esac
done
lockname=package-lock.json
[ "$manager" = npm ] || lockname=pnpm-lock.yaml

self=$(realpath "$0" 2>/dev/null || echo "$0")
root=$(cd "$(dirname "$self")/.." && pwd -P)
cli="$root/dist/cli.js"
[ -f "$cli" ] || { echo "croak-install: $cli not found (run pnpm build in the croak repo)" >&2; exit 2; }

# The workspace root, if this directory is inside one, read as JSON by croak
# (the hook's reading, D38). croak may read anything here but writes and
# spawns nothing. The plan then checks this folder is one of its members.
member="" ws=""
if [ "$mode" != empty ]; then
  start=$(pwd -P)
  ws=$(node --permission "--allow-fs-read=*" --disallow-code-generation-from-strings "$cli" workspace-root "$manager" "$start") || exit 3
  if [ -n "$ws" ] && [ "$ws" != "$start" ]; then
    member=${start#"$ws"/}
    cd "$ws"
  fi
fi
case "$mode" in
  ci) [ "$#" -eq 0 ] || usage
      [ -f "$lockname" ] || { echo "croak-install: $manager ci needs a $lockname here" >&2; exit 2; } ;;
  empty) [ "$#" -gt 0 ] || usage ;;
  project | update) [ -f package.json ] || { echo "croak-install: no package.json here; run it in a project directory" >&2; exit 2; } ;;
esac
if [ "$mode" != empty ] && [ "$manager" = npm ] && [ -f npm-shrinkwrap.json ]; then
  echo "croak-install: npm-shrinkwrap.json is not supported yet, so this install was not checked" >&2
  exit 2
fi
command -v "$manager" >/dev/null || { echo "croak-install: $manager is not installed" >&2; exit 3; }


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

# The real path: Node's permission model checks resolved paths (/var → /private/var).
work=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/croak-install.XXXXXX")" && pwd -P)
trap 'rm -rf "$work"' EXIT INT TERM
mkdir "$work/home" "$work/bin" "$work/plan"
: >"$work/user.npmrc"
: >"$work/global.npmrc"
printf '#!/bin/sh\necho "croak-install: git is disabled while planning" >&2\nexit 1\n' >"$work/bin/git"
chmod +x "$work/bin/git"
# corepack (often what `pnpm` is) runs only a version already in the user's
# corepack cache: its network is off, so no project can make it fetch one.
corepack_home="${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}"
# Both package managers, isolated the same way.
plan_at="$work/plan"
isolated() { # isolated <command...>, run in $plan_at
  (cd "$plan_at" && env -i PATH="$work/bin:$PATH" HOME="$work/home" \
    XDG_CONFIG_HOME="$work/home/.config" XDG_CACHE_HOME="$work/cache" XDG_DATA_HOME="$work/home/.local/share" \
    COREPACK_HOME="$corepack_home" COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_AUTO_PIN=0 \
    npm_config_userconfig="$work/user.npmrc" npm_config_globalconfig="$work/global.npmrc" \
    npm_config_cache="$work/cache" npm_config_registry="https://registry.npmjs.org/" \
    npm_config_git=/usr/bin/false npm_config_ignore_scripts=true "$@")
}

# pnpm's own rule for whose install scripts run (D38), from the project's
# settings and the pnpm that would install. Empty for npm, or when unknown.
pnpm_version=""
if [ "$manager" = pnpm ]; then
  pnpm_version=$(isolated pnpm --version 2>/dev/null | tail -n 1) || pnpm_version=""
fi
plan() { # plan <extra read path> <croak plan args...>: adds the pnpm policy, one quoted word each
  extra=$1
  shift
  [ -z "$member" ] || set -- "$@" --member "$member"
  if [ -n "$pnpm_version" ]; then
    croak "$extra" plan "$@" --pnpm-builds "$project" --pnpm-version "$pnpm_version"
  elif [ "$manager" = pnpm ]; then
    # Without a version, no build rule; the pnpmfile is still checked.
    croak "$extra" plan "$@" --pnpm-builds "$project"
  else
    croak "$extra" plan "$@"
  fi
}

if [ "$mode" = ci ]; then
  # npm ci and pnpm --frozen-lockfile install the lockfile as is: nothing to plan.
  # shellcheck disable=SC2086 # json and llm are one fixed flag or empty
  plan "$project" --before none --after "$lockname" --project "$project" $json $llm
  exit $?
fi

if [ "$mode" = empty ]; then
  echo '{ "name": "croak-empty", "version": "0.0.0", "private": true }' >"$work/plan/package.json"
  baseline=--before baseline_value=none
else
  # Every manifest of a workspace, never node_modules or .git; a name with a
  # control character could break the copy, so it is refused instead.
  if [ -n "$ws" ]; then
    if find . \( -name node_modules -o -name .git \) -prune -o -name '*[[:cntrl:]]*' -print | grep -q .; then
      echo "croak-install: a file name in this workspace has a control character, so it was not checked" >&2
      exit 3
    fi
    # find copies regular files only and does not enter linked folders, but
    # the package manager follows links, and pnpm also reads package.yaml and
    # package.json5: any of them would leave a member out of the plan (M6 review).
    find . \( -name node_modules -o -name .git \) -prune -o -type l -print >"$work/links"
    while IFS= read -r f; do
      case "$f" in */package.json | */package.yaml | */package.json5) linked=1 ;; *) linked=0 ;; esac
      if [ "$linked" = 1 ] || [ -d "$f" ]; then
        echo "croak-install: $f is a symbolic link in this workspace, so it was not checked" >&2
        exit 3
      fi
    done <"$work/links"
    if [ "$manager" = pnpm ] && find . \( -name node_modules -o -name .git \) -prune -o \( -name package.yaml -o -name package.json5 \) -print | grep -q .; then
      echo "croak-install: this workspace has a package.yaml or package.json5, which croak does not read, so it was not checked" >&2
      exit 3
    fi
    find . \( -name node_modules -o -name .git \) -prune -o -type f -name package.json -print | head -n 5001 >"$work/manifests"
    if [ "$(wc -l <"$work/manifests")" -gt 5000 ]; then
      echo "croak-install: more than 5000 package.json files in this workspace, so it was not checked" >&2
      exit 3
    fi
    while IFS= read -r f; do
      mkdir -p "$work/plan/$(dirname "$f")"
      cp "$f" "$work/plan/$f"
    done <"$work/manifests"
  fi
  croak "$project" sanitize root-manifest package.json >"$work/plan/package.json" || exit 3
  if [ "$manager" = pnpm ] && [ -f pnpm-workspace.yaml ]; then
    croak "$project" sanitize pnpm-workspace pnpm-workspace.yaml >"$work/plan/pnpm-workspace.yaml" || exit 3
  fi
  [ ! -f "$lockname" ] || cp "$lockname" "$work/plan/$lockname"
  baseline=--installed baseline_value=$project
fi

packages_given=$#
if [ "$manager" = npm ]; then
  npm_command=install
  [ "$mode" != update ] || npm_command=update
  set -- npm "$npm_command" --package-lock-only --ignore-scripts --no-audit --no-fund -- "$@"
else
  pnpm_command=install
  [ "$#" -eq 0 ] || pnpm_command=add
  [ "$mode" != update ] || pnpm_command=update
  set -- pnpm "$pnpm_command" --lockfile-only --ignore-scripts --registry=https://registry.npmjs.org/ \
    --config.manage-package-manager-versions=false "$@"
fi
# From a member's folder, as the agent ran it: pnpm add refuses the root.
[ -z "$member" ] || plan_at="$work/plan/$member"
if ! isolated "$@" >"$work/plan.log" 2>&1; then
  if grep -qE "E404|ERR_PNPM_FETCH_404|404 Not Found" "$work/plan.log"; then
    # Most often a mistyped or AI-invented name; an attacker may register it later.
    echo "croak-install: a requested package does not exist on npm. Check the name:" >&2
    echo "AI agents often invent plausible package names, and attackers register them." >&2
    grep -E "404" "$work/plan.log" | head -n 3 >&2
    missing=$(sed -n 's#.*GET https://registry.npmjs.org/\([^ :]*\).*#\1#p' "$work/plan.log" | sort -u)
    set -f
    # shellcheck disable=SC2086 # one registry path per word, from the package manager's log
    [ -z "$missing" ] || croak "$work" suggest $missing >&2
    set +f
    exit 2
  fi
  echo "croak-install: $manager could not plan this install, so it was not checked:" >&2
  tail -n 15 "$work/plan.log" >&2
  exit 3
fi
if [ ! -f "$work/plan/$lockname" ] && [ -n "$member" ] && [ -f "$work/plan/$member/$lockname" ]; then
  # The package manager planned the folder as its own project (M6 review).
  echo "croak-install: $member is inside a workspace that does not list it as a member, so the install would not run where croak planned it" >&2
  exit 3
fi
[ -f "$work/plan/$lockname" ] || { echo "croak-install: $manager wrote no $lockname, so this install was not checked" >&2; exit 3; }

# A plain install also runs the project's own install scripts (D35).
# shellcheck disable=SC2086 # json and llm are one fixed flag or empty
if [ "$mode" = project ] && [ "$packages_given" -eq 0 ]; then
  plan "$work" "$baseline" "$baseline_value" --after "$work/plan/$lockname" --project "$project" $json $llm
else
  plan "$work" "$baseline" "$baseline_value" --after "$work/plan/$lockname" $json $llm
fi

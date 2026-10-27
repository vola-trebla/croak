#!/bin/sh
# croak-hook — a Claude Code PreToolUse hook for Bash (D32). Reads the hook
# event on stdin, finds what the command would install, checks each install
# with croak-install, and answers deny (🔴, incomplete, unchecked) or ask (🟡);
# silence lets the command through the normal permission flow.
# Claude Code lets a command through when a hook fails (exit 1, crash,
# timeout) unless the hook is registered with "onFailure": "block". This
# script also fails closed itself: any error it can see is exit 2 (deny).
set -u

deny() { echo "🐸 croak could not check this command, so it blocked it: $1" >&2; exit 2; }

self=$(realpath "$0" 2>/dev/null || echo "$0")
here=$(dirname "$self")
cli="$here/../dist/cli.js"
install="$here/croak-install.sh"
[ -f "$cli" ] || deny "$cli not found (run pnpm build in the croak repo)"
# Below Node 24.2 the CLI's entry point does not run and exits 0 with no
# output: every step would "succeed" silently, and every install would pass.
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 24 || (a === 24 && b >= 2) ? 0 : 1)' ||
  deny "croak needs Node 24.2 or later (found $(node --version 2>/dev/null || echo none))"

work=$(mktemp -d "${TMPDIR:-/tmp}/croak-hook.XXXXXX") || deny "no temporary directory"
trap 'rm -rf "$work"' EXIT INT TERM
cat >"$work/input.json" || deny "could not read the hook input"

node "$cli" hook plan "$work/input.json" >"$work/plan" 2>"$work/plan.err" ||
  deny "$(head -c 400 "$work/plan.err")"
# A plan always starts with its plan line; anything else means croak did not run.
head -n 1 "$work/plan" | grep -q "^plan$(printf '\t')" || deny "croak produced no plan"

tab=$(printf '\t')
while IFS= read -r line; do
  case "$line" in check"$tab"*) ;; *) continue ;; esac
  old_ifs=$IFS; IFS=$tab; set -f
  # shellcheck disable=SC2086 # split the tab-separated fields on purpose
  set -- $line
  set +f; IFS=$old_ifs
  id=$2 manager=$3 mode=$4 dir=$5
  shift 5
  case "$manager" in
    npm) pm="" ;;
    pnpm) pm="--pnpm" ;;
    *) deny "unknown package manager: $manager" ;;
  esac
  case "$mode" in
    project) flags="--json $pm" ;;
    update) flags="--json --update $pm" ;;
    ci) flags="--json --ci $pm" ;;
    empty) flags="--json --empty $pm" ;;
    *) deny "unknown check mode: $mode" ;;
  esac
  # shellcheck disable=SC2086 # flags are fixed words chosen above
  (cd "$dir" && sh "$install" $flags -- "$@") >"$work/$id.out" 2>"$work/$id.err"
  echo $? >"$work/$id.code"
done <"$work/plan"

node "$cli" hook decide "$work" 2>"$work/decide.err" || deny "$(head -c 400 "$work/decide.err")"
exit 0

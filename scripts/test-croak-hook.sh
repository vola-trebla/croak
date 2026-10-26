#!/bin/sh
# Offline test of the Claude Code hook (D32): feeds it PreToolUse events and
# checks its answers. The bait package's scripts would create a marker file;
# the test fails if any of them ran.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/croak-hook-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
marker="$work/SCRIPT-RAN"
mkdir -p "$work/bait/package" "$work/project"
cat >"$work/bait/package/package.json" <<JSON
{ "name": "croak-bait", "version": "1.0.0", "scripts": { "postinstall": "touch $marker" } }
JSON
(cd "$work/bait" && tar -czf croak-bait-1.0.0.tgz package)
echo '{ "name": "project", "version": "1.0.0", "private": true }' >"$work/project/package.json"

hook() { # hook <command>: prints the hook's stdout, then "exit=<code>"
  set +e
  printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"%s"}}' \
    "$work/project" "$1" | sh "$root/scripts/croak-hook.sh" 2>"$work/stderr"
  echo "exit=$?"
  set -e
}
expect() { # expect <label> <output> <pattern>
  echo "$2" | grep -q -- "$3" || { echo "FAIL: $1: expected $3 in:"; echo "$2"; cat "$work/stderr"; exit 1; }
}

out=$(hook "ls -la && git status")
[ "$out" = "exit=0" ] || { echo "FAIL: a command that installs nothing got an answer: $out"; exit 1; }
out=$(hook "npm install $work/bait/croak-bait-1.0.0.tgz")
expect "an install script" "$out" '"permissionDecision":"ask"'
expect "an install script" "$out" "install/install-script"
out=$(hook 'cd sub && npm i $PKG')
expect "a run-time package" "$out" '"permissionDecision":"deny"'
out=$(hook "pnpm add zod")
expect "pnpm" "$out" '"permissionDecision":"deny"'
set +e
echo "not json" | sh "$root/scripts/croak-hook.sh" >/dev/null 2>&1
code=$?
set -e
[ "$code" -eq 2 ] || { echo "FAIL: bad input must exit 2 (deny), got $code"; exit 1; }
[ ! -e "$marker" ] || { echo "FAIL: a lifecycle script ran"; exit 1; }
[ ! -e "$work/project/node_modules" ] || { echo "FAIL: the project was installed into"; exit 1; }
echo "ok: hook stays silent, asks, denies, and fails closed; no script ran"

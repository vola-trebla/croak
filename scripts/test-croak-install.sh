#!/bin/sh
# Offline proof for the security model (§5): croak-install plans an install
# without running any lifecycle script. A bait package whose preinstall and
# postinstall would create a marker file is installed from a local tarball;
# the test passes only if no marker exists afterwards and croak flags it.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/croak-install-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
marker="$work/SCRIPT-RAN"

mkdir -p "$work/bait" "$work/project"
cat >"$work/bait/package.json" <<JSON
{ "name": "croak-bait", "version": "1.0.0",
  "scripts": { "preinstall": "touch $marker", "postinstall": "touch $marker", "prepare": "touch $marker" } }
JSON
(cd "$work/bait" && env -i PATH="$PATH" HOME="$work" npm pack --ignore-scripts --silent >/dev/null)
echo '{ "name": "project", "version": "1.0.0", "private": true }' >"$work/project/package.json"

set +e
out=$(cd "$work/project" && sh "$root/scripts/croak-install.sh" "$work/bait/croak-bait-1.0.0.tgz" 2>&1)
code=$?
set -e

[ ! -e "$marker" ] || { echo "FAIL: a lifecycle script ran during planning"; exit 1; }
[ ! -e "$work/project/package-lock.json" ] || { echo "FAIL: the project's files were modified"; exit 1; }
echo "$out" | grep -q "install/install-script" || { echo "FAIL: install script not flagged (exit $code):"; echo "$out"; exit 1; }
echo "ok: no lifecycle script ran, project untouched, install script flagged (exit $code)"

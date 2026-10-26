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

mkdir -p "$work/bait/package" "$work/project"
cat >"$work/bait/package/package.json" <<JSON
{ "name": "croak-bait", "version": "1.0.0",
  "scripts": { "preinstall": "touch $marker", "postinstall": "touch $marker", "prepare": "touch $marker" } }
JSON
# Packed with tar, not npm pack: npm 10's pack runs `prepare` despite --ignore-scripts.
(cd "$work/bait" && tar -czf croak-bait-1.0.0.tgz package)
echo '{ "name": "project", "version": "1.0.0", "private": true }' >"$work/project/package.json"

set +e
out=$(cd "$work/project" && sh "$root/scripts/croak-install.sh" "$work/bait/croak-bait-1.0.0.tgz" 2>&1)
code=$?
set -e

[ ! -e "$marker" ] || { echo "FAIL: a lifecycle script ran during planning"; exit 1; }
[ ! -e "$work/project/package-lock.json" ] || { echo "FAIL: the project's files were modified"; exit 1; }
echo "$out" | grep -q "install/install-script" || { echo "FAIL: install script not flagged (exit $code):"; echo "$out"; exit 1; }
echo "ok: no lifecycle script ran, project untouched, install script flagged (exit $code)"

# A fresh clone: the lockfile lists the bait, node_modules does not exist.
# npm install (no packages, or any package) would install and run the bait,
# so the plan must include it even though the lockfile already has it.
clone="$work/clone"
mkdir -p "$clone"
echo '{ "name": "clone", "version": "1.0.0", "private": true }' >"$clone/package.json"
(cd "$clone" && env -i PATH="$PATH" HOME="$work" npm install --package-lock-only --ignore-scripts --no-audit --no-fund \
  "$work/bait/croak-bait-1.0.0.tgz" >/dev/null 2>&1)
[ -f "$clone/package-lock.json" ] || { echo "FAIL: could not prepare the clone's lockfile"; exit 1; }
for mode in "" "--ci"; do
  set +e
  out=$(cd "$clone" && sh "$root/scripts/croak-install.sh" $mode 2>&1)
  set -e
  echo "$out" | grep -q "install/install-script" || { echo "FAIL: fresh clone ${mode:-install} missed the locked bait:"; echo "$out"; exit 1; }
done
[ ! -e "$marker" ] || { echo "FAIL: a lifecycle script ran during planning"; exit 1; }
[ ! -e "$clone/node_modules" ] || { echo "FAIL: the clone was installed into"; exit 1; }

# --empty plans into an empty project (npx, npm install -g); --json is machine-readable.
set +e
out=$(cd "$work" && sh "$root/scripts/croak-install.sh" --json --empty "$work/bait/croak-bait-1.0.0.tgz" 2>&1)
set -e
echo "$out" | grep -q '"kind": "install-plan"' || { echo "FAIL: --json --empty gave no plan report:"; echo "$out"; exit 1; }
echo "$out" | grep -q "install/install-script" || { echo "FAIL: --empty missed the bait"; exit 1; }
[ ! -e "$marker" ] || { echo "FAIL: a lifecycle script ran during planning"; exit 1; }
echo "ok: fresh clone, --ci, --empty and --json checked; no script ran"

# A forged hidden lockfile: the repo commits node_modules/.package-lock.json
# (a copy of the lockfile) without the package folders. npm still installs
# everything, so croak must not treat the tree as installed (M4 review).
mkdir -p "$clone/node_modules"
cp "$clone/package-lock.json" "$clone/node_modules/.package-lock.json"
set +e
out=$(cd "$clone" && sh "$root/scripts/croak-install.sh" 2>&1)
set -e
echo "$out" | grep -q "install/install-script" || { echo "FAIL: a forged hidden lockfile hid the bait:"; echo "$out"; exit 1; }

# Workspaces and npm-shrinkwrap.json are not checked yet: refuse (D34).
for setup in workspaces shrinkwrap; do
  proj="$work/$setup"
  mkdir -p "$proj"
  if [ "$setup" = workspaces ]; then
    echo '{ "name": "ws", "version": "1.0.0", "private": true, "workspaces": ["packages/*"] }' >"$proj/package.json"
  else
    echo '{ "name": "sw", "version": "1.0.0", "private": true }' >"$proj/package.json"
    echo '{}' >"$proj/npm-shrinkwrap.json"
  fi
  set +e
  out=$(cd "$proj" && sh "$root/scripts/croak-install.sh" left-pad 2>&1)
  code=$?
  set -e
  [ "$code" -eq 2 ] && echo "$out" | grep -q "not supported yet\|does not check yet" ||
    { echo "FAIL: $setup was not refused (exit $code):"; echo "$out"; exit 1; }
done
echo "ok: forged hidden lockfile, workspaces and shrinkwrap handled"


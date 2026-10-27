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

# npm-shrinkwrap.json is not checked yet: refuse (D34).
sw="$work/shrinkwrap"
mkdir -p "$sw"
echo '{ "name": "sw", "version": "1.0.0", "private": true }' >"$sw/package.json"
echo '{}' >"$sw/npm-shrinkwrap.json"
set +e
out=$(cd "$sw" && sh "$root/scripts/croak-install.sh" left-pad 2>&1)
code=$?
set -e
[ "$code" -eq 2 ] && echo "$out" | grep -q "not supported yet" || { echo "FAIL: shrinkwrap was not refused (exit $code):"; echo "$out"; exit 1; }

# An npm workspace: a member's dependency is planned from the root (D38),
# even when croak-install runs inside the member, and the member's own
# install scripts are checked. The workspaces key is written with an escape,
# which npm reads as the key (M6 review).
ws="$work/workspace"
mkdir -p "$ws/packages/a" "$ws/examples/demo"
echo '{ "name": "ws", "version": "1.0.0", "private": true, "work\u0073paces": ["packages/*"] }' >"$ws/package.json"
printf '{ "name": "a", "version": "1.0.0", "scripts": { "postinstall": "node setup.js" }, "dependencies": { "croak-bait": "file:%s" } }\n' "$work/bait/croak-bait-1.0.0.tgz" >"$ws/packages/a/package.json"
echo "require('fs').writeFileSync('$marker', '')" >"$ws/packages/a/setup.js"
set +e
out=$(cd "$ws/packages/a" && sh "$root/scripts/croak-install.sh" 2>&1)
set -e
echo "$out" | grep -q "install/install-script" || { echo "FAIL: the workspace member's dependency was not planned:"; echo "$out"; exit 1; }
echo "$out" | grep -q "packages/a/package.json" || { echo "FAIL: the member's postinstall was not checked:"; echo "$out"; exit 1; }
[ ! -e "$marker" ] || { echo "FAIL: a lifecycle script ran during planning"; exit 1; }
# A project inside the workspace folder that is not a member: npm installs it
# on its own, not where croak would plan, so the check is incomplete.
echo '{ "name": "demo", "version": "1.0.0" }' >"$ws/examples/demo/package.json"
set +e
out=$(cd "$ws/examples/demo" && sh "$root/scripts/croak-install.sh" 2>&1)
code=$?
set -e
[ "$code" -eq 3 ] && echo "$out" | grep -q "does not list it as a member" || { echo "FAIL: a non-member was planned at the root (exit $code):"; echo "$out"; exit 1; }
echo "ok: forged hidden lockfile, shrinkwrap refused, npm workspace planned from its root, non-member refused"

# A cache path with a space must not split into a script node would run
# (whole-project review): a project file at the second half prints a forged
# clean report if it ever runs.
spaced="$work/x y"
mkdir -p "$spaced" "$work/clone/y/croak"
echo 'console.log(JSON.stringify({ status: "complete", verdict: "allow", findings: [] }))' >"$work/clone/y/croak/content"
set +e
out=$(cd "$work/clone" && XDG_CACHE_HOME="$spaced" sh "$root/scripts/croak-install.sh" --ci 2>&1)
set -e
echo "$out" | grep -q "install/install-script" || { echo "FAIL: a cache path with a space changed what ran:"; echo "$out"; exit 1; }
[ -d "$spaced/croak/content" ] || { echo "FAIL: the spaced cache directory was not used"; exit 1; }
echo "ok: a cache path with a space stays one argument"

# pnpm (D38): the same bait, planned with --pnpm; nothing runs, nothing in
# the project changes.
if command -v pnpm >/dev/null; then
  pp="$work/pnpm-project"
  mkdir -p "$pp"
  echo '{ "name": "pp", "version": "1.0.0", "private": true, "packageManager": "pnpm@9.15.0" }' >"$pp/package.json"
  set +e
  out=$(cd "$pp" && sh "$root/scripts/croak-install.sh" --pnpm "$work/bait/croak-bait-1.0.0.tgz" 2>&1)
  set -e
  echo "$out" | grep -q "install/source" || { echo "FAIL: pnpm did not plan the bait:"; echo "$out"; exit 1; }
  [ ! -e "$marker" ] || { echo "FAIL: a lifecycle script ran during pnpm planning"; exit 1; }
  [ ! -e "$pp/pnpm-lock.yaml" ] && [ ! -e "$pp/node_modules" ] || { echo "FAIL: the pnpm project was modified"; exit 1; }

  # A pnpm workspace whose settings would load code: the plan still works,
  # because croak sanitize drops configDependencies and the pnpmfile.
  pw="$work/pnpm-workspace"
  mkdir -p "$pw/packages/b"
  echo '{ "name": "pw", "version": "1.0.0", "private": true }' >"$pw/package.json"
  printf 'packages:\n  - packages/*\nconfigDependencies:\n  evil-config: 1.0.0+sha512-AAAA\npnpmfile: .pnpmfile.cjs\n' >"$pw/pnpm-workspace.yaml"
  echo "require('fs').writeFileSync('$marker', '')" >"$pw/.pnpmfile.cjs"
  printf '{ "name": "b", "version": "1.0.0", "dependencies": { "croak-bait": "file:%s" } }\n' "$work/bait/croak-bait-1.0.0.tgz" >"$pw/packages/b/package.json"
  set +e
  out=$(cd "$pw" && sh "$root/scripts/croak-install.sh" --pnpm 2>&1)
  set -e
  echo "$out" | grep -q "install/source" || { echo "FAIL: the pnpm workspace was not planned:"; echo "$out"; exit 1; }
  [ ! -e "$marker" ] || { echo "FAIL: the pnpmfile or a script ran during planning"; exit 1; }
  # pnpm add from a member's folder plans there: pnpm refuses to add to the root.
  set +e
  out=$(cd "$pw/packages/b" && sh "$root/scripts/croak-install.sh" --pnpm "$work/bait/croak-bait-1.0.0.tgz" 2>&1)
  set -e
  echo "$out" | grep -q "install/source" || { echo "FAIL: pnpm add in a member was not planned:"; echo "$out"; exit 1; }
  [ ! -e "$marker" ] || { echo "FAIL: a script ran during pnpm planning"; exit 1; }
  echo "ok: pnpm planned the bait and a workspace whose settings would load code; nothing ran"
else
  echo "skip: pnpm is not installed"
fi


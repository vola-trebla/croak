#!/bin/sh
# Smoke test of croak as npm ships it (M8): packs the package, installs the
# tarball globally into a temporary prefix, and runs every binary from there,
# outside the repo. Checks that the tarball holds only what croak needs, that
# each binary resolves dist/ inside the installed package, and that the
# installed croak-install and hook still plan without running any script.
# Needs `pnpm build` first and the network (the package's one dependency).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd -P)
[ -f "$root/dist/cli.js" ] || { echo "FAIL: run pnpm build first"; exit 1; }
work=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/croak-tarball-test.XXXXXX")" && pwd -P)
trap 'rm -rf "$work"' EXIT INT TERM
marker="$work/SCRIPT-RAN"
mkdir -p "$work/home" "$work/pack" "$work/prefix"
: >"$work/npmrc"
# npm with no user config, cache or scripts of its own: only the tarball counts.
npm_isolated() { (cd "$work" && env HOME="$work/home" npm_config_userconfig="$work/npmrc" \
  npm_config_cache="$work/cache" npm_config_ignore_scripts=true npm "$@"); }

(cd "$root" && npm pack --ignore-scripts --pack-destination "$work/pack" >/dev/null 2>&1)
tgz=$(find "$work/pack" -name '*.tgz' | head -n 1)
[ -n "$tgz" ] || { echo "FAIL: npm pack wrote no tarball"; exit 1; }

# Only the built CLI, the two wrappers, and the standard files: no sources,
# tests, fixtures (src/crypto/fixtures holds test keys), eval or tooling.
tar -tzf "$tgz" | while IFS= read -r entry; do
  case "$entry" in
    package/package.json | package/README.md | package/LICENSE) ;;
    package/scripts/croak-install.sh | package/scripts/croak-hook.sh) ;;
    package/dist/*.js) ;;
    *) echo "FAIL: the tarball ships $entry"; exit 1 ;;
  esac
done
for need in package/dist/cli.js package/scripts/croak-install.sh package/scripts/croak-hook.sh; do
  tar -tzf "$tgz" | grep -qx "$need" || { echo "FAIL: the tarball lacks $need"; exit 1; }
done
echo "ok: the tarball holds dist/, the two wrappers, README, LICENSE and package.json only"

npm_isolated install --global --prefix "$work/prefix" --no-audit --no-fund "$tgz" >"$work/install.log" 2>&1 ||
  { echo "FAIL: the tarball did not install:"; tail -n 20 "$work/install.log"; exit 1; }
bin="$work/prefix/bin"
for b in croak croak-install croak-hook; do
  [ -x "$bin/$b" ] || { echo "FAIL: $b is not installed as a binary"; exit 1; }
  # Each binary must live in the installed package, never in this repo.
  case "$(realpath "$bin/$b")" in
    "$work/prefix/"*) ;;
    *) echo "FAIL: $b resolves to $(realpath "$bin/$b")"; exit 1 ;;
  esac
done
want=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$root/package.json")
got=$(cd "$work" && "$bin/croak" --version)
[ "$got" = "$want" ] || { echo "FAIL: croak --version printed '$got', package.json says $want"; exit 1; }
echo "ok: croak, croak-install and croak-hook installed from the tarball; croak --version is $got"

# croak repo on a fake test assignment, from the installed CLI.
out=$(cd "$work" && "$bin/croak" repo "$root/eval/cases/d-known-tool-chained/fixture" --json || true)
echo "$out" | grep -q '"verdict": "block"' || { echo "FAIL: installed croak repo did not block:"; echo "$out"; exit 1; }

# croak-install and the hook on a bait package whose script would leave a marker.
mkdir -p "$work/bait/package" "$work/project"
cat >"$work/bait/package/package.json" <<JSON
{ "name": "croak-bait", "version": "1.0.0", "scripts": { "postinstall": "touch $marker" } }
JSON
(cd "$work/bait" && tar -czf croak-bait-1.0.0.tgz package)
echo '{ "name": "project", "version": "1.0.0", "private": true }' >"$work/project/package.json"
out=$(cd "$work/project" && "$bin/croak-install" "$work/bait/croak-bait-1.0.0.tgz" 2>&1 || true)
echo "$out" | grep -q "install/install-script" || { echo "FAIL: installed croak-install missed the bait:"; echo "$out"; exit 1; }
out=$(printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm install %s"}}' \
  "$work/project" "$work/bait/croak-bait-1.0.0.tgz" | "$bin/croak-hook" 2>&1 || true)
echo "$out" | grep -q '"permissionDecision":"ask"' || { echo "FAIL: the installed hook did not ask about the bait:"; echo "$out"; exit 1; }
[ ! -e "$marker" ] || { echo "FAIL: a lifecycle script ran"; exit 1; }
[ ! -e "$work/project/node_modules" ] || { echo "FAIL: the project was installed into"; exit 1; }
echo "ok: installed croak repo, croak-install and croak-hook checked their targets; no script ran"

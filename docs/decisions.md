# Decision log

Short records of why things are the way they are. Newest at the bottom.

## D1 — Node 24.2+ as the minimum runtime (2026-10-24, amended 2026-10-25)

Node 24 is LTS and has `import.meta.main`, `util.parseArgs`, and native
type stripping. Dropping older versions keeps the code free of polyfills.
The floor is 24.2.0 because `import.meta.main` first shipped there; on 24.0/24.1
it is `undefined`, the CLI silently does nothing and exits 0 — a fail-open.
CI tests both the minimum (24.2.0) and the latest 24.x.
**Trade-off:** users on Node 22 or early 24.x cannot run croak.

## D2 — pnpm for development (2026-10-24)

Strict `node_modules`, fast installs, and pnpm does not run dependency build
scripts by default — the same idea croak is built on. pnpm is also an ecosystem
croak must support (M6), so we feel its behavior firsthand.
**Trade-off:** contributors need pnpm (pinned via `packageManager`).

## D3 — Biome instead of ESLint + Prettier (2026-10-24)

One dev dependency for lint and format, versus a dozen packages for the
ESLint stack. Fits the "minimal dependencies" principle. `noExplicitAny` is an error.
**Trade-off:** fewer plugins and rules than the ESLint ecosystem.

## D4 — Zero runtime dependencies (2026-10-24)

croak is itself an npm package; every runtime dependency is attack surface.
Use Node built-ins (`node:util`, `node:crypto`, `fetch`, `node:zlib`).
Any exception must be justified here.
**Trade-off:** we write some code (e.g. tar parsing) that a library would give us.

## D5 — GitHub Actions pinned by commit SHA (2026-10-24)

Tags are mutable and have been repointed to malicious commits in past attacks.
SHA pins with a version comment; `permissions: contents: read`;
`persist-credentials: false` on checkout.
**Trade-off:** updates are manual (or via Dependabot later).

## D6 — Private repo until M8 (2026-10-24, superseded by D21)

Iterate freely, open the repo with a working MVP, eval results, and the article.
**Trade-off:** no early community feedback.

## D7 — AI agent setup lives in the repo (2026-10-25)

`CLAUDE.md`, `.claude/skills/` (`/ship`, `/sync`), `.claude/agents/toad-reviewer.md`,
and a read-only command allowlist in `.claude/settings.json` are committed.
They document the engineering workflow for any AI agent and contributor.
Personal preferences (language, tone) stay in user-level config;
`.claude/settings.local.json` and `CLAUDE.local.md` are gitignored.
The allowlist only covers exact read-only commands — no `:*` prefix rules for
git, because prefix rules accept any flag (`git log --output=<path>` writes an
arbitrary file; found in the M0 review). Anything that changes state
(push, PR, publish, format) still asks. The agent did not grant itself these
permissions — the maintainer added the file.
**Trade-off:** the repo is opinionated about tooling; contributors without
Claude Code simply ignore these files.

## D8 — Git hooks without husky (2026-10-25)

`.githooks/pre-commit` runs `biome check --staged` (instant); `.githooks/pre-push`
runs `pnpm check`. Enabled with `git config core.hooksPath .githooks`.
husky installs hooks through a `prepare` lifecycle script — the install-time
execution mechanism croak exists to gate — and adds a dependency.
**Trade-off:** one manual setup command per clone.

## D9 — Review cadence: machines per PR, toad per milestone (2026-10-25)

Per-line LLM review is noisy and misses architecture. Invariants that can be
checked mechanically (no code execution APIs in analysis code, no runtime
dependencies, no `any`) run in CI on every PR (from M1). `toad-reviewer`
reviews the whole codebase at each milestone's end. First run (M0) found an
allowlist file-write hole, a Node 24.0/24.1 fail-open, and Vitest executing
fixture tests.
**Trade-off:** non-mechanical issues can live up to one milestone.

## D10 — Run TypeScript directly with Node, `.ts` import specifiers (2026-10-25)

Node 24 strips types natively, so dev tools like `pnpm eval` run `src/` with no
build step. Relative imports use `.ts`; `rewriteRelativeImportExtensions`
makes tsc emit `.js` for the published build. `erasableSyntaxOnly` keeps the
code within what Node can strip (no enums, no parameter properties).
Eval code lives in `src/eval/` but is excluded from the published build.
**Trade-off:** no enums/namespaces/parameter properties; imports look unusual
to people used to `.js` specifiers.

## D11 — POSIX only for now (2026-10-25)

Safe reads rely on `O_NOFOLLOW` and inode checks. On Windows `O_NOFOLLOW` does
not exist and junctions behave differently, so croak refuses to scan there
rather than run with a silently weaker guard. `package.json` declares
`"os": ["darwin", "linux"]`.
**Trade-off:** no Windows users until someone designs the equivalent guard.

## D12 — Eval regression rule: once passed, always passes (2026-10-25)

A test runs the registered detectors over every case and fails if a case that
passed in any `eval/history/*.json` snapshot no longer passes. Snapshots are
recorded at the end of each milestone. Changing a case's expectation on
purpose means recording a new snapshot in the same PR.
**Trade-off:** a deliberate behavior change needs an explicit history update.

## D13 — Milestone reviews cover the diff since the last review (2026-10-25)

The M1 batch review took about 5 minutes on the whole codebase, and that would
grow with the repo. After each review the merge commit is tagged
`review/<milestone>`; the next `toad-reviewer` run covers
`git diff review/<previous>...HEAD` plus the modules that diff touches.
A whole-codebase review happens only on request (e.g. before M8).
Depth (probes that verify findings) stays: it found the real issues in M0 and M1.
**Trade-off:** cross-cutting problems in untouched code surface later.

## D14 — `croak repo` exit codes and a versioned JSON report (2026-10-25)

`0` allow or warn, `1` block, `2` usage error, `3` scan incomplete. Warnings
print but do not fail the process: a human decides. Agent integrations (M4)
treat `3` as a block (fail-closed), because an incomplete scan is never a clean
one. `--json` emits `{ "schema": 1, ... }`; the schema number changes whenever
the shape does, since hooks parse it.
**Trade-off:** scripts that want to fail on warnings must parse the JSON.

## D15 — `node_modules` in a scanned repo: one warning, details as info (2026-10-25)

The first real run (croak on its own repo) warned on a >1 MB vite bundle in
`node_modules`; installed projects are full of those. Ignoring `node_modules`
would reopen the "hide it in a committed node_modules" hole. Instead, each
`node_modules` directory yields one `repo/node-modules-present` warning
(`croak repo` targets fresh clones, which should not contain installed
dependencies), and oversized files inside it are `info`.
**Trade-off:** scanning your own installed project shows one warning per
`node_modules` directory; a malicious committed `node_modules` is a warn, not
a block, until content detectors inspect it.

## D16 — Pattern-data files: statement-level invariant checks (2026-10-25)

Detectors and their tests must hold strings such as `require("child_process")`
or `eval(atob(…))` as data; a regex tripwire cannot tell data from code. A file
whose first lines contain `// croak-invariants: pattern-data` gets
statement-level rules instead: a real `import`/`require`/dynamic import/`eval`
that starts a statement is still a violation, and non-test files keep the
fs-write rule. The marker is allowed only under `src/signals/`,
`src/detectors/`, `src/install/` (install detectors, added in M3), and the ReDoS guard; anywhere else it is itself a violation.
Separately, test files are exempt from `no-eval` (strings are test data) but
not from the loading rules (`import()`, `require`, `child_process`, `vm`, …).
**Trade-off:** an expression-level loading call inside a marked file
(`foo(require(x))`) is not caught; review covers the two allowed directories.

## D17 — Install-script verdicts and analysis depth (2026-10-25)

Any install script warns. Network alone warns; network plus secrets, process,
eval, or decode blocks, as does download-and-execute (detected by parsing the
shell command, not by one regex). Known tools add info and never lower a
verdict. croak reads the script, its inline code, and the files it runs
directly — not their `require` graph. The limit is stated in the security
model and README so the warning is not mistaken for a full audit.
**Trade-off:** a payload one `require` away from the executed file is not seen
by this detector.

## D18 — PR size budget (2026-10-25)

PRs #4–#8 grew to 600–2000 changed lines (one to 44k with generated
fixtures) and took 10+ minutes to build, against the small-steps rule. Now:
one PR does one thing (module, detector, case set, or docs), stays around
300 changed lines excluding generated fixtures and about 15 minutes of work,
starts with a short plan, and stops at a checkpoint if it runs long. `/ship`
checks the size before opening a PR.
**Trade-off:** more PRs and merges per feature; each is reviewable in minutes.

## D19 — Inert-tool install scripts are info, not warnings (2026-10-25, hardened after the M2 review)

The real-world corpus put 7 of 13 popular repositories at 🟡 for routine
scripts like `prepare: husky` or `prepare: npm run build` → `tsc`. Warnings
that everyone learns to ignore defeat the tool. A script is info only when
every command is an **inert** tool (husky, tsc, simple-git-hooks, echo, …) or a
package-manager call that runs a script which is itself routine — including
npm's `pre`/`post` hooks for it — and nothing else is present: no network,
local files, inline code, code signals, environment assignments
(`NODE_OPTIONS=…`, `PATH=…`), redirects, wrappers (`sudo`, `npx --package`),
or workspace-wide runs (`-r`, `--filter`). Every package-manager call must run
a script, so `npm install x && npm run build` is not routine.

The M2 review laundered the first version into info several ways (an env
preload before `tsc`, a nested install, a redirect into `~/.zshenv`, a
`prebuild` hook) and showed that tools like vite, prisma, turbo, or
patch-package execute code from the repo. Those are now **executing** tools:
recognized with a note, but the script stays a warning. Resolution is
memoized per script, so a layered script graph cannot stall the scan.
**Trade-off:** croak trusts an inert tool's name; whether that tool's package
is itself honest is the install check's job (M3). Some 🟡 returned on the
corpus — that is the honest number.

## D20 — Agents: block on 🔴, ask on 🟡 (2026-10-25)

In agent integrations (M4), 🔴 and "scan incomplete" block the install. 🟡 does
not block: the agent shows the findings and asks the user to confirm. A nested
install found by a scan (`cd client && npm install`) is checked again as its
own install rather than trusted.
**Trade-off:** a 🟡 attack that the user waves through gets installed; blocking
every 🟡 would turn ordinary work into an obstacle course and teach users to
disable the hook.

## D21 — Open the repo after M2, not M8 (2026-10-25)

`croak repo` works end to end, tests and the eval are reproducible, and the
limits are documented. Waiting for M8 delays feedback for no safety gain. The
repo opens marked early-stage; the README says what croak does not catch.
**Trade-off:** rough edges are public; the README must stay honest about them.

## D22 — Package name `@vola-trebla/croak` (2026-10-25)

`croak` is likely taken on npm. A scoped name avoids a conflict now; the name
is checked for availability and confusion with existing projects before the
first publish (M8), because renaming after users arrive is painful.
**Trade-off:** a scoped name is longer to type.

## D23 — croak runs under Node's permission model (2026-10-25)

Checked in practice: with `--permission`, read access limited to croak and the
target, and `--disallow-code-generation-from-strings`, croak gives the same
verdicts while spawning, writing, workers, and eval are denied. CI runs a
sandboxed scan on every PR; the M4 hook will invoke croak this way. Network
is not covered by Node 24 and stays a documented gap.
**Trade-off:** callers must pass the target as an allowed read path.

## D24 — Install planning: npm runs in a wrapper, croak reads lockfiles (2026-10-25)

To know the exact tree an install brings in, npm must resolve it. Running npm
from croak would break the never-spawn invariant and the sandbox (D23); a
home-made resolver would be approximate. Instead a small wrapper
(`croak-install`) runs `npm install --package-lock-only --ignore-scripts` in an
isolated temporary directory and hands croak two lockfiles; `croak plan`
judges every new or changed package version, transitive ones included. The
isolation is documented in the security model §5 and proven offline in CI.
**Trade-off:** two steps instead of one; npm is isolated, not sandboxed.

## D25 — Release age is a weak signal (2026-10-25)

A version published in the last 7 days is a 🟡 on its own and never a 🔴 by
itself: many legitimate releases are new. It only strengthens other signals,
such as suspicious content or a change in provenance. Likewise, missing
provenance is "no data", not an attack; a provenance that disappeared
compared with earlier versions, or that fails to verify, is a different and
stronger signal.
**Trade-off:** a brand-new malicious version with no other signal is only a
warning.

## D26 — Install signals: alone they warn, two patterns block (2026-10-25)

Registry signals per new or changed version — release under 7 days old,
provenance dropped compared with recent versions, a publisher who did not
publish earlier versions, a name one keystroke from a popular package, a
package created under 30 days ago — are each a 🟡. Two combinations are 🔴:
an install script together with dropped provenance or a new publisher (the
shape of a hijacked maintainer account, as in the 2026 axios incident), and a
typo-squat name on a brand-new package (typo-squatting or a registered
hallucinated name). Provenance that never existed is "no data", not a signal;
verifying signatures is M7. Any registry failure makes the check incomplete.
**Trade-off:** a hijack that keeps the old publisher and never had
provenance is only caught by its content (M3 3/4).

## D27 — Package contents: read in memory, judged as a dependency (2026-10-25)

`croak plan` downloads the tarball of every new or changed registry version
(https, registry.npmjs.org only), verifies it against the lockfile's
integrity hash (a mismatch blocks), and reads it in memory with hard limits
(security model §3); any limit or registry failure makes the check
incomplete. The repo detectors then run with a dependency policy: npm runs
only `preinstall`, `install` and `postinstall`, only from the package's own
`package.json`; network plus spawning or decoding is a binary installer and
warns, network plus secrets or eval blocks. Each version is compared with its
previous one: a new install script warns, and blocks together with a
registry warning; a new dependency that is itself under 30 days old blocks —
how the 2026 axios release smuggled in `plain-crypto-js`.
**Trade-off:** large plans download a lot; a plan over 300 MB is incomplete
rather than partly checked.

## D28 — Real packages recalibrate the rules (2026-10-25)

Running `croak-install` on lodash, axios, react, esbuild, sharp, puppeteer,
typescript and next blocked five of them. None was an attack. Changes:
- Obfuscation: weak signals (escapes, base64 blobs) block only next to code
  execution (eval, Function, vm), since decoding alone makes data (parsers'
  Unicode tables, webpack's wasm); local strong signals block only next to
  eval or decoding; on lines over 1,000 characters "next to" means within
  200 characters. `$eval(` and `Function("return this")` are not eval.
- Secrets: the whole `process.env` counts only when passed to a call or
  walked, not when destructured or handed to a child process.
- A new publisher alone is info, and does not count with provenance (a CI
  identity); with an install script it still blocks (D26). Prebuilt `.node`
  binaries and large JSON data files are info.
- Platform packages the lockfile marks for another `os`/`cpu` are skipped:
  npm will not install them here.
  After the changes: 0 blocks on all eight; warnings left on esbuild (an
  install script that downloads a binary), puppeteer and next (releases under
  7 days old, a computed global call). Eval and the repo corpus are unchanged.
  **Trade-off:** escapes decoded and run through a child process rather than
  eval are no longer an obfuscation block; the lifecycle rules still see the
  spawn at install time.

## D29 — Verdict cache moves to M4; real malware stays references only (2026-10-26)

The verdict cache (`name@version + integrity`) serves the agent hook, which
checks the same installs again and again; `croak plan` runs once per install
and does not need it, so it moves to M4. Real malicious packages are not
used as eval fixtures: they are referenced by name, version, hash and source
(`ossf/malicious-packages`, incident reports) in the docs, never committed,
and npm removes most of them anyway. The eval stays synthetic, with the
references showing which real attacks each synthetic case stands for.
**Trade-off:** no measured recall on real samples until a gitignored local
run is added; the numbers are for synthetic attacks only.

## D30 — A new publisher blocks only with a new or changed install script (2026-10-26)

The package corpus blocked sqlite3 6.0.1: a maintainer listed on the package,
who had not published before, released it with the install script it had
for years. D26's hijack pattern (install script plus a new publisher) now
needs the install script to be new or changed compared with the previous
version; the same script with a new publisher is a 🟡. Dropped provenance
with an install script still blocks either way.
**Trade-off:** a hijacker who keeps `node install.js` and edits `install.js`
is left to the content checks; if the edit looks harmless there, it is a 🟡
(the agent asks), not a 🔴.

## D31 — M3 review: read like npm, compare with settled history (2026-10-26)

The M3 toad review found ways around the install check, all fixed:
- The tar reader disagreed with node-tar (a single zero block, pax sizes,
  the ustar prefix, old GNU/pax types), so a tarball could show croak one
  file and install another. It now follows node-tar or rejects the archive.
- Bundled dependencies inside a tarball are judged like the package itself:
  npm runs their install scripts.
- One predicate (`registryTarball`) decides what is downloaded, checked
  online, and reported as a non-registry source, so no entry falls between.
- Comparisons with earlier versions use only versions at least 7 days older
  (a fresh decoy release cannot become the baseline), and the previous
  version is the semver predecessor.
  **Trade-off:** a patient attacker who publishes a decoy more than 7 days
  ahead still sets the baseline; the content checks remain.

## D32 — The agent hook: what it catches and how it answers (2026-10-26)

A Claude Code `PreToolUse` hook on Bash commands finds install intents before
they run: `npm install`/`add`/`update` (with or without packages, `-g`
included), `npm ci`, and `npx` / `npm exec` / `npm create` (they download a
package and run it at once). It follows `cd`, `--prefix` and `sh -c`, so a
nested `cd client && npm install` is checked too (D20). Whatever croak
cannot vouch for — pnpm, yarn and bun until M6, a custom registry or npm
config, a package or directory only known when the shell runs, `eval`, text
it cannot parse — is `unchecked`, never ignored. 🔴, incomplete and
unchecked map to `deny`, 🟡 to `ask` (Claude Code asks the user), 🟢 to
silence (the normal permission flow; croak never grants a permission). The verdict cache keeps content checks only (a tarball never changes
for its hash); registry facts such as release age are always fresh. Setup
is a documented `.claude/settings.json` snippet; croak never edits the
user's config.
**Trade-off:** an install hidden inside a package.json script (`npm run
setup`) is not seen by the hook; `croak repo` covers those scripts.

## D33 — croak may write one thing: its content verdict cache (2026-10-27)

Without a cache, every agent install on a fresh clone checks the whole tree
again — minutes per `npm install`. The cache keeps content findings by
tarball sha512 (npm verifies the download against the same hash) and croak's
code fingerprint; registry facts are never cached (D32). Writing breaks the
"croak never writes" rule the tripwire enforces, so it is allowed in one
file only, into one directory, and `croak-install` now runs croak under
Node's permission model with write access to that directory alone (keeping
D23's promise for the hook). A failed write or read is a miss, never an
error. Chosen over no cache (too slow for agents) and a shell-side cache
(JSON handling in shell, harder to test).
**Trade-off:** a user-writable cache can be forged by anything that can
already write the user's files.

## D34 — M4 review: read commands like the shell and npm, check where npm installs (2026-10-27)

The M4 toad review found many ordinary install commands the hook let through.
Fixed, and decided with the maintainer:
- The command reader follows shell keywords (`if`/`then`, loops, functions,
  `!`), wrappers with values (`timeout 300`, `sudo -u root`), `$(…)`,
  combined shell flags (`bash -lc`), and npm's own argument rules: `-C` and
  `-L` take values, `-p` is `--parseable` (only npx reads it as `--package`),
  npx stops at its command, subcommands match by unique prefix and camelCase
  (`npm upd`). An unknown option followed by a word, a script piped into a
  shell, a shell heredoc that mentions npm, and a package manager run through
  another command (`xargs npm i`) are unchecked.
- The hook checks npm's local prefix (the nearest directory with a
  package.json or node_modules), not the agent's directory, and `npm update`
  as an update. "Installed" means a hidden-lockfile entry whose folder holds
  that package (and, since D35, matches the plan's source and hash).
- Not supported yet, so denied (maintainer's choice): npm workspaces (since
  D38 checked from their root instead) and `npm-shrinkwrap.json`; any npm config that points at a registry other than
  the public one (project or user `.npmrc`, `npm_config_*`, `--…registry`
  flags, `npm config set` or a write to `.npmrc` in the same command).
  **Trade-off:** monorepos with workspaces and teams with a private registry
  cannot use the hook yet; it denies rather than checks the wrong install.

## D35 — Whole-project review: the project's own scripts, and seams between layers (2026-10-27)

A review of all of croak, not one milestone's diff, found bypasses where the
layers meet. Fixed:
- A plain `npm install` and `npm ci` also run the project's own install
  scripts (and node-gyp for a root binding.gyp); `croak plan --project`
  judges them with the repo rules, on the manifest and the files they run.
  This is the fake test-assignment attack, end to end through the hook.
- Packages are compared and deduplicated on name, version, resolved URL and
  integrity, so a second copy from another URL, or an installed copy whose
  hash differs from the plan's, is checked; a registry tarball URL that
  belongs to another package than the entry's name is an `install/source`
  warning.
- A project `.npmrc` is read the way npm reads it (quoted keys, `[sections]`
  refused), and keys that load another config or change what npm runs
  (`userconfig`, `globalconfig`, `script-shell`, `node-options`, `shell`,
  `git`, `init-module`) are refused there; the user's own npmrc files are
  checked for registries only.
- The hijack pattern uses the registry's word on install scripts, not only
  the lockfile's.
- The hook denies when croak cannot run (Node below 24.2, or no plan line)
  instead of passing everything; sandbox flags stay one argument each, so a
  cache path with a space can never make node run a project file.
  **Trade-off:** the global npmrc and npm's built-in config are not read; they
  belong to the user, not the repo.

## D36 — The LLM layer: Claude Haiku 5.5 through the official SDK (2026-10-27)

M5 adds an opt-in LLM triage of a package's version diff. The maintainer
chose the cheapest model, Claude Haiku 5.5 ($0.10 / $0.50 per million input
/ output tokens), and the official SDK over a hand-written `fetch` client,
as simpler and the supported path. That is the one exception to D4: the
tripwire allows `@anthropic-ai/sdk` in `dependencies` only, pinned to an
exact version. 0.133.0 was chosen as the newest release over two weeks old
(the 1.x line was days old, D25), and croak checked it: one false
`dynamic-call` warning (`self[Symbol.asyncIterator]()`), since fixed. The
model runs only on 🟡 packages, only with a key and an explicit opt-in;
its answer can only add a finding (escalate-only, invariant 2), package
content is untrusted input inside a random boundary, and any failure falls
back to the deterministic verdict. (M5 review: the SDK is loaded lazily, through one
literal dynamic import the tripwire allows, so commands that do not run the
step never load it.)
**Trade-off:** croak now has a dependency tree (the SDK and three packages
of its own) that must be kept pinned and checked on every update.

## D37 — The LLM step is wired in, opt-in, and checked on real packages (2026-10-27)

`croak plan --llm`, and `CROAK_LLM=1` for `croak-install` and the hook, run
the LLM step after the rules: for each package with a warning and no block,
both tarballs (this version and the previous one) are downloaded and
hash-checked, the diff goes to Claude Haiku 5.5, and the answer is merged by
`escalate()`. Without a key, or on any failure (download, refusal, malformed
answer), the rules decide and the report says the model did not judge. The
report shows the calls and their cost. On the 61-package corpus the model
added no blocks (20 benign, 1 suspicious, $0.02 in all), which is the check
the ablation's caveat asked for.
**Trade-off:** the step re-downloads the tarballs it judges (the content
cache stores findings, not tarballs) and adds a few seconds per warned
package; answers are not cached yet.

## D38 — pnpm: lockfile v9, its own script rules, workspaces for both managers (2026-10-27)

M6 makes croak check pnpm installs, with three choices by the maintainer:
- **A strict reader for pnpm-lock.yaml, no new dependency.** Only the YAML
  pnpm writes (block mappings, quoted keys, flow collections, scalar lists,
  several documents) plus flow collections spread over lines by formatters
  such as Biome; anything else is a LockfileError, so the check is
  incomplete, never guessed at. Lockfile v9 only (pnpm 9 and later).
- **pnpm's own script rules.** pnpm 10 does not run dependencies' install
  scripts unless they are allowed (`onlyBuiltDependencies`); an install
  script pnpm will not run is info, not a warning. With "allow all" or a
  pnpm older than 10, scripts count as for npm.
- **Workspaces, for npm and pnpm alike.** The planning wrapper copies every
  package.json of the project (not node_modules) and pnpm-workspace.yaml, so
  monorepos are checked instead of refused; this lifts D34's workspace
  refusal once the wrapper does it.
  **Trade-off:** pnpm records no install-script flag, so install scripts are
  known from the registry manifest and the tarball, not from the lockfile.

## D39 — pnpm can run code while planning; the wrapper sanitizes what it copies (2026-10-27)

Checked in practice: in a project whose package.json says
`"packageManager": "pnpm@9.15.0"`, `pnpm install --lockfile-only
--ignore-scripts` (pnpm 12 through corepack) downloaded pnpm 9.15.0 and ran
it, even with `manage-package-manager-versions=false`; a version already in
corepack's cache ran without a download. So a repo chooses which package
manager binary runs during croak's "safe" planning. pnpm-workspace.yaml can
also load pnpmfiles and config dependencies (code). The wrapper therefore
copies the root manifest without `packageManager`/`devEngines` (and keeps
only resolution settings in its `pnpm` field), copies pnpm-workspace.yaml
with resolution settings only, never copies `.pnpmfile.cjs`, and runs
corepack with its network off over the user's own cache: only a pnpm the
user already has can run. The sanitizing is croak's (`croak sanitize`, which
has the YAML reader), the copying the wrapper's. An offline test plants a
pnpmfile and config dependencies and checks that nothing ran.
**Trade-off:** pnpm resolves without the project's patches and pnpmfile
hooks, so a plan can differ from the real install where those change
resolution; it is then a plan of the unpatched tree, still checked.

## D40 — The hook checks pnpm, and the pnpmfile is install-time code (2026-10-27)

The hook now reads `pnpm add/install/update/dlx/create` and `pnpx` like npm
(with pnpm's flags: `-C`/`--dir`, `--filter`, `--frozen-lockfile` as a ci,
`--registry` and `pnpm_config_*` as foreign config) and checks them with
`croak-install --pnpm`; a workspace member's install is checked at the
workspace root (`pnpm-workspace.yaml` or npm `workspaces`), and
`pnpm-workspace.yaml` is checked for other registries. Like the project's
own install scripts for npm (D35), pnpm runs the project's pnpmfile on every
install, scripts or not: `.pnpmfile.cjs` (or the file `pnpmfile:` names) is a
warning, a block when its code reaches the network with secrets or eval;
config dependencies are a warning. yarn and bun stay denied.
**Trade-off:** `pnpm approve-builds` and `pnpm rebuild` run scripts of
packages already installed; the hook does not re-check those, since the
install showed what they do.

## D41 — M6 review: workspaces and pnpm installs croak could miss (2026-10-27)

The M6 toad review found nine ways a pnpm or workspace install could reach
🟢 while running code croak never checked, or warn on nothing. Fixed:
- **Members' scripts.** A plain install runs every workspace member's
  install scripts, not only the root's; the members come from the planned
  lockfile (npm's `packages` keys outside node_modules, pnpm's `importers`).
  pnpm's `pnpm:devPreinstall` counts too. An npm member's own lockfile entry
  is a local folder, not a package with "no resolved source".
- **Where the install runs.** The workspace root is read as JSON by
  `croak workspace-root` (shared with the hook), not grepped; the hook hands
  over the folder npm stands in, the plan runs from that member's folder,
  and a folder the planned lockfile does not list as a member is incomplete.
  A linked manifest or folder, and for pnpm a `package.yaml` or
  `package.json5`, is refused: the copy would leave a member out.
- **pnpm flags and settings.** pnpm flags come from allowlists (an unknown
  flag leaves the command unchecked) and every installing subcommand is
  mapped. Settings that run the repo's code or trust another server
  (`scriptShell`, `nodeOptions`, `shellEmulator`, `globalPnpmfile`, proxies,
  `ca`/`strictSsl`, `namedRegistries`, and their `.npmrc` forms) are
  refused. `pnpmfile` may be a list; `patchedDependencies` is a warning.
- **The pnpm that really runs.** pnpm's build rule applies only when the
  project pins nothing or exactly the measured pnpm; the pnpmfile is checked
  even when the version is unknown. YAML comments are dropped and every
  boolean spelling is read.

**Trade-off:** a project inside a workspace folder that the workspace does
not list is refused rather than planned on its own; checking it as its own
project is a follow-up. Eval cases for pnpm and workspaces need install-case
support for pnpm lockfiles and project scripts; until then, unit tests and
`scripts/test-croak-install.sh` cover these shapes.

## D42 — M7: croak verifies signatures itself, against keys it pins (2026-10-31)

M7 adds three separate checks, never merged into one "verified" badge:
registry signatures (the tarball is what the registry has), provenance (which
workflow built it from which commit), and the tarball against the source at
the attested commit. The maintainer chose:
- **Own verifier on `node:crypto`.** Registry signatures and Sigstore bundles
  are ECDSA P-256, which Node verifies without a library; sigstore-js would
  bring dozens of transitive dependencies and break D4. Crypto code is easy
  to get subtly wrong, so every check is tested on real signatures and on a
  tampered copy of each field it reads.
- **Pinned trust roots.** npm's registry keys, the Fulcio roots and the
  Rekor key live in croak's code. Keys fetched from the same server as the
  packument would only check the server against itself. A key croak does
  not know (a rotation croak missed) is "unverifiable": 🟡, so an agent asks
  the user instead of every install being blocked until croak is updated.
- **Severity.** Broken is 🔴: a registry signature by a known key that does
  not verify, or a provenance claim that does not verify. A change is 🟡: a
  version without a registry signature, or a source repo or workflow that
  differs from the previous version's; with a new install script it is 🔴,
  as in D30. Provenance never lowers a finding.
- **Source comparison stays narrow.** Only `package.json` at the attested
  commit (raw.githubusercontent.com, following `repository.directory`):
  install scripts, `bin` and `gypfile` that the tarball has and the source
  does not. Prebuilt binaries without source are not compared yet.

**Trade-off:** pinned keys go stale. Rotations are rare and announced, and
an unknown key fails towards asking, not towards passing; there is no TUF
client to update the roots by themselves.

## D43 — The Sigstore verifier: what it checks and what it leaves out (2026-10-31)

`verifyProvenance()` (src/crypto/sigstore.ts, with src/crypto/rekor.ts) checks an npm SLSA provenance
bundle against Sigstore's public-good instance, pinned in code (D42): the
Rekor v1 signed entry timestamp (SET) over the log entry, the signing
certificate chained to the Fulcio CA and valid when the entry was logged,
code signing only, the DSSE signature over the in-toto statement, a log
entry that is exactly this signature and certificate, and a subject that is
this package, version and sha512. Who built it comes from the certificate's
Fulcio extensions, never from the statement the build wrote about itself.
Both bundle shapes npm serves are read: v0.3 with a dsse entry, and the
2023 v0.1 shape with an intoto entry. Live: 40 releases with provenance
verify, none fail: the 36 in the package corpus (`eval/packages.json`,
scoped ones included) and four 2023-shape releases (semver@7.5.2,
sigstore@1.3.0, @sigstore/bundle@1.0.0, @sigstore/core@1.0.0). The "42"
first reported counted vite and hono twice.

Left out, each one "unverifiable" (🟡) rather than a pass:
- **Rekor v2** (Ed25519, since 2025-09) and any log croak does not pin;
  every npm bundle seen on 2026-10-31 is in Rekor v1.
- **Entries without a SET.** The Merkle inclusion proof and checkpoint are
  not checked: the SET is Rekor's signed promise of the entry and its time,
  which is what binds the short-lived certificate.
- **RFC 3161 timestamps and certificate transparency (SCTs)** are not read.
- **Signing keys other than EC or RSA.** Fulcio also certifies Ed25519
  keys; npm's are EC (D45).

A bundle with no log entry at all (an RFC 3161-only bundle, say) is invalid
(🔴), not unverifiable: croak requires a Rekor entry to date the signature.

Compared between versions: the repository (its numeric id at its issuer, so
a rename is not a change) and the workflow file. **Not compared: the git
ref.** On the package corpus, 6 of 36 packages (react, react-dom, koa,
@babel/core, playwright, tailwindcss) alternate between release branches
and tags from one version to the next; a ref check would ask about each.

**Trade-off:** a bundle that names a log croak does not pin is asked about,
not blocked; a bundle that does not verify against what croak pins blocks.

## D44 — Tarball vs source moves to Later (2026-10-31)

D42 planned a narrow source comparison: the tarball's install scripts,
`bin` and `gypfile` against `package.json` at the attested commit. A survey
of the package corpus (36 packages with verified provenance) showed it does
not hold up:
- For 4 of the 16 packages with install scripts or `bin` (next, playwright,
  puppeteer, esbuild), the source manifest cannot be found: they publish from
  a monorepo folder without `repository.directory`, so the repository root
  holds another manifest (`nextjs-project`, `puppeteer-repo`) or none.
- The folder to look in comes from the tarball itself. An attacker who
  controls the build output (the threat this check is for) can drop or
  point `repository.directory` elsewhere. Treating "not found" as 🟡 would
  make every `next` install ask the user; treating it as silence lets the
  attacker skip the check.
- Where the manifest was found, nothing differed; a new or changed install
  script is already caught against the previous version (D27, D30).

Finding the manifest reliably means reading the repository tree at the
commit, which is too heavy for the hook. So M7 closes with registry
signatures and provenance; the source comparison waits in Later, with this
survey as its starting point. This supersedes D42's last bullet.

## D45 — M7 review: a baseline gap, a crash, and checks no test held (2026-10-31)

The M7 toad review (`review/m6..main`) found no way for a forged or altered
package, signature, bundle or log entry to verify. It found:
- **A gap in the provenance baseline.** A planned version was compared only
  with its semver predecessor; when that release had no provenance, the
  repository check was skipped without a word. A release without provenance
  could hide a later build from another repository. The baseline is now the
  newest settled version with provenance, install scripts are compared with
  that same version, and messages name it (eval: `a-provenance-after-gap`).
- **A crash on registry input.** `verify("sha256", …)` throws on an Ed25519
  key, and the error escaped `croak plan`. Keys other than EC or RSA are
  unverifiable, and the DSSE and SET checks go through `verifies()`, which
  answers false instead of throwing.
- **Checks no test held.** Deleting the chain signature, CA, code signing,
  validity, logged certificate or payload hash checks left every test green.
  New test certificates (Ed25519, CA, no code signing, late start) and
  tests now kill each deletion; `checkIssued` alone survives, because the
  signature check subsumes it. OpenSSL counts a `CA:TRUE` certificate as a
  CA only with `keyCertSign`, so the test CA leaf carries it.
- **Repository ids** are compared with their issuer (GitHub and GitLab ids
  overlap).
- **Latency:** provenance and content checks run side by side, and verified
  provenance findings are cached under the tarball hash and the baseline
  (warm plan of 30 corpus packages: 0.8 s → 0.6 s, 32 → 0 attestation
  requests). Cache files are named by hash and label.
- **Docs:** the security model lists the pinned roots and the attestations
  request; D43 states the corpus numbers, the invalid no-log-entry case and
  why refs are not compared.
- Smaller: registry facts are read once per version; a sha1-only lockfile
  entry gets an info note that its hash was not compared with the signed
  one.

Not changed: the ref (6 of 36 corpus packages would warn, see D43), and
`der.ts` accepting a non-minimal OID encoding (only bytes Fulcio signed
reach it).

## D46 — The install eval covers pnpm lockfiles (2026-10-31)

D41 left pnpm without eval cases: an install case could only carry
package-lock.json. A case may now carry pnpm-lock.yaml instead, and the
harness reads the project's build rule from the fixture's package.json and
pnpm-workspace.yaml the way `croak plan --pnpm-builds` does, with a fixed
pnpm 10 version. Three cases, all on one package, pin the rule from both
sides:
- a malicious postinstall the project never approved still blocks
  (`a-pnpm-install-script-exfil`): pnpm will not run it today, but a later
  `pnpm approve-builds` would;
- an honest binary installer the project did not approve is a note
  (`benign-pnpm-unapproved-build`, allow);
- the same installer approved in `allowBuilds` warns, as under npm
  (`benign-pnpm-approved-build`).

The harness fills each `resolution: {}` with the built tarball's hash
textually, line by line, and croak's own parser then reads the result: a
test-only shortcut that keeps fixtures hand-written, with no YAML writer.

**Trade-off:** the pnpmfile and config-dependency checks (D39) and the
project's own scripts still have no eval cases; they come with project
manifests in install cases (D47).

## D47 — Install cases can carry the project (2026-10-31)

The checks on the project's own files ran only through `croak plan
--project` and `--pnpm-builds`: no eval case reached them, though the fake
test assignment (threat D) attacks exactly there. A fixture's root
package.json is now the project, installed with a plain install, and the
harness adds what the planning wrapper adds: the project's install scripts
and its workspace members' (D35, D41), and on pnpm cases the pnpmfile and
config dependencies (D39). A fixture without package.json is about its
packages alone, so the 26 earlier install cases are unchanged.

Six cases, each with a twin: a test assignment's own postinstall (block)
against husky in prepare (allow); the same exfil in a workspace member's
preinstall (block) against a member's `prisma generate` (warn); a
`.pnpmfile.cjs` that posts the environment (block) against one that pins
a dependency (warn).

Writing them found a harness bug: workspace members in an npm fixture
lockfile got a registry URL filled in, as if they were downloads.

**Trade-off:** the project-level part is a copy of the CLI's wiring
(`runPlan` in src/cli.ts), not shared code; a change to one must be
mirrored in the other, and the cases are what catches a drift.

## D48 — A folder the workspace does not list is planned on its own (2026-10-31)

D41 refused a project inside a workspace folder that the workspace does not
list (exit 3): an agent working in `examples/demo` of a monorepo could not
install anything there. The wrapper already ran the package manager from
that folder in the copied workspace, and the package manager's own choice
showed where the real install goes: a lockfile in the folder, not at the
root, means it installs the folder as a project of its own. That plan is
not used, because it lacked the folder's own lockfile and its manifest was
not sanitized. The folder is planned again, from scratch, exactly as a
project outside any workspace: its sanitized package.json, its lockfile,
its node_modules as the baseline, its own install scripts, and its own
`npm-shrinkwrap.json` refused (D34).

Observed: npm 11 installs such a folder on its own; pnpm 12.4.2 adds it to
the workspace lockfile as an importer and installs from the root, so the
plan stays at the root. Both follow from what the package manager wrote,
not from croak's reading of the workspace globs.

Unchanged: `--ci` in such a folder stays incomplete, since no package
manager runs to tell where it installs, and `croak plan` still refuses a
`--member` the planned lockfile does not list, as a backstop. This lifts
D41's trade-off.

**Trade-off:** planning such a folder runs the package manager twice.

## D49 — The npm package and how 0.1.0 reaches npm (2026-10-31)

The package is `@vola-trebla/croak` (D22; the bare `croak` belongs to
someone else), first version **0.1.0**: 0.x says early stage, as the README
does. package.json gains `repository` (provenance requires it to match the
repository that builds the package), `homepage`, `bugs`, `keywords` and
`publishConfig.access: public` (a scoped package is private by default),
and loses `private`. `bin` paths all start with `./`. A test ties the
CLI's `--version` to package.json's version.

How releases happen, chosen by the maintainer:
- **0.1.0 by hand.** npm lets a trusted publisher be set only on a package
  that exists, so the maintainer publishes the first version from a laptop
  (2FA, no token stored anywhere). It has no provenance.
- **Every later version from CI**, from a `v*` tag, through npm trusted
  publishing (OIDC): no long-lived token, provenance generated by npm.
  The release workflow comes in its own change.

`publishConfig.provenance` is not set: a publish outside CI fails with it,
which would break the manual first release, and trusted publishing adds
provenance by itself; the workflow also passes `--provenance`.

**Trade-off:** the first version on npm is the one version croak cannot
check the provenance of; the self-check demo waits for 0.1.1.

## D50 — The release workflow (2026-11-01)

`.github/workflows/release.yml` publishes from a `v*` tag, the second and
every later version (D49). Two jobs (split in the M8 review):
- **verify**, with no right to an OIDC token: the tag must equal
  package.json's version; then what CI runs on Node 24 (check, ReDoS,
  eval, build, `--version`, both wrapper tests, the `--permission` sandbox
  run of D23) plus the tarball smoke test; then `npm pack`, once, and the
  tarball goes up as an artifact with its sha512 in the log. CI's Node
  24.2.0 matrix entry is not repeated.
- **publish**, the only job with `id-token: write`: no checkout, no package
  manager, no dev dependency. It checks npm is 11.5.1 or later (trusted
  publishing), downloads the artifact, checks it is exactly the tagged
  version's tarball, and runs `npm publish <tarball> --provenance --access
  public --ignore-scripts`. A compromised dev tool runs only where no token
  can be requested, and what npm gets is the tarball verify tested.

Also: npm trusted publishing (no npm token anywhere; the trusted publisher
names this repository and this workflow file, so a renamed file stops
publishing), no dependency cache, no `registry-url` (no token placeholder
in an `.npmrc`), and every action pinned by commit SHA, an invariant over
all workflows (`pinned-actions`). Who may push a `v*` tag is a tag ruleset
(admin only). The maintainer chose no environment approval gate: with the
split, the remaining risk is a takeover of the maintainer's own account.

**Trade-off:** a release reruns the whole suite rather than trusting the
CI run on the same commit; the split workflow is first exercised by the
next tag (0.1.2).

## D51 — 0.1.0 is out; croak's first look at itself (2026-11-01)

The maintainer published 0.1.0 by hand (D49): 60 files, and the registry's
sha512 matches a local `npm pack` byte for byte. `croak-install --empty
@vola-trebla/croak` then warned about croak itself:
- **New package, released today** (`install/new-package`,
  `install/recent-release`): true, and they lapse with time.
- **A changed build workflow in its dependency:** `@anthropic-ai/sdk`
  0.133.0 was built by `publish-npm.yml`, 0.131.0 by `create-releases.yml`.
  A real M7 signal on a legitimate change; asking about it is the design.
- **Obfuscation in croak's own detector:** a false alarm. Comments in the
  obfuscation detector quote `globalThis[key](…)`, and tsc kept comments
  in dist/. The build now drops them (`removeComments`), and the tarball
  smoke test scans croak's own installed files.

0.1.1 carries that fix and is the first version published from CI with
provenance (D50), so croak can verify its own build.

**Open for the M8 review:** the obfuscation detector also matches inside
comments of other packages; dropping croak's own comments hides that
class here, it does not fix it.

## D52 — A forged root lockfile could hide a non-member's install (2026-11-01)

The M8 toad review found that D48 only re-planned a folder the workspace
does not list when the workspace root had **no** lockfile. The wrapper
copies the root lockfile into the plan folder before npm runs, and npm,
planning the folder on its own, leaves that copy as it was; the old check
read its presence as "npm planned at the root". So in the usual monorepo,
with a root lockfile:
- an honest root lockfile made the folder incomplete (exit 3), so D48 did
  nothing where it matters;
- a root lockfile that lists the folder as a member, which any repository
  can write, passed `croak plan`'s member check: the plan used the root
  lockfile, and croak said **allow** for an install whose own dependency
  (with a postinstall) it never saw. The reviewer probed it; a fake test
  assignment is exactly that repository. The gap dates from M6 (the exit 3
  check had the same condition); D48 described it as safe.

The wrapper now decides by what the package manager wrote: the copy holds
only package.json files, so a lockfile inside the member's folder can only
come from the package manager planning that folder apart from the
workspace. For npm, the folder is planned again on its own (D48). For pnpm,
which also writes one for a real member under `sharedWorkspaceLockfile:
false`, it is refused (exit 3): planning that member alone would leave the
rest of the workspace out. Tests cover an honest and a forged root lockfile,
with a bait only the folder depends on.

**Trade-off:** `croak plan --member` still trusts the planned lockfile's
member list as its backstop; the wrapper is what keeps a forged list from
standing in for the package manager's own plan.

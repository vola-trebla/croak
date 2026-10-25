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

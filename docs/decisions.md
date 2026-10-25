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

## D6 — Private repo until M8 (2026-10-24)

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

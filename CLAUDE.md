# croak — guide for AI agents

`croak` is a pre-execution gate for package installs, built for AI coding agents
first. It statically checks what an install (or an unfamiliar repo) would do
**before any of its code runs**, and explains its verdict so an agent can
self-correct.
- Plan and milestones: [ROADMAP.md](ROADMAP.md)
- Why things are the way they are: [docs/decisions.md](docs/decisions.md)
- What croak trusts and how analysis stays safe: [docs/security-model.md](docs/security-model.md)

## Commands

```bash
nvm use            # Node 24.2+ (see .nvmrc)
pnpm install
git config core.hooksPath .githooks   # once per clone: pre-commit + pre-push gates
pnpm check         # lint + typecheck + invariants + test — run before every commit
pnpm format        # Biome autofix
pnpm build         # tsc -> dist/
pnpm eval          # run the eval (see eval/README.md)
pnpm croak repo .  # run the CLI from source
```

Note: pnpm 12 does not accept `-s`.

## Invariants (never break these)

1. **croak never executes analyzed code.** No `eval`, `new Function`, `require`,
   `import()`, `child_process` on analyzed files or package contents. Install
   plans use `--package-lock-only` / `--lockfile-only` with `--ignore-scripts`.
   Vitest only collects `src/**/*.test.ts` — fixtures may ship their own tests.
2. **The LLM layer can only escalate.** Deterministic findings are the floor; an
   LLM result may raise severity but must never lower or remove a finding.
   Package contents are untrusted input to the LLM (prompt injection).
3. **Fail-closed for agents, warn for humans.** 🔴 and "incomplete" block an
   agent; 🟡 makes it ask the user (D20). An LLM failure alone falls back to
   deterministic checks.
4. **Zero runtime dependencies** (D4). Use Node built-ins. Any exception needs a
   decision record.
5. **Never commit real malware.** Eval references real samples by name/hash
   only; `eval/samples/` is gitignored. Synthetic fixtures use harmless payloads
   (e.g. "exfil" to `localhost`).

## Code style

- TypeScript strict; no `any` (use `unknown` + type guards).
- Functional style where practical; classes for domain models only when they
  earn it. KISS and YAGNI beat speculative abstraction.
- Pure core, thin I/O shell (see `run()` in `src/cli.ts`).
- Small focused modules, flat structure.
- Tests co-located: `foo.ts` → `foo.test.ts`.
- Every detector ships with two eval cases: a malicious one it must catch and a
  benign twin it must not flag. Detectors never key off the `SYNTHETIC` marker.
- Relative imports use the `.ts` extension (Node runs `src/` directly; tsc
  rewrites them to `.js` on build).
- Fail fast with explicit error types; never swallow errors.
- Everything in the repo is in English: code, comments, commits, PRs, docs.

## Workflow

Small, reviewable steps. Never work for long stretches without checking in.

**Size budget (D18):** one PR = one thing — a module, or a detector, or a set
of eval cases, or docs. Aim for ≤ ~300 changed lines (generated fixtures
excluded) and ≤ ~15 minutes of work. Post a 3–5 line plan before starting;
if work runs past ~15 minutes, stop and report where you are. A feature is a
chain of PRs: module → detector → cases → docs. Review fixes: 1–2 findings
per PR.
1. One task = one branch: `<type>/<milestone>-<topic>`
   (`feat/m1-eval-schema`, `fix/cli-unknown-flag`, `chore/claude-setup`).
2. Test first, then a small code change, then `pnpm check`.
3. Log notable decisions in `docs/decisions.md`.
4. `/ship` — commit, push, open a PR. **Never merge; the maintainer merges.**
5. After the maintainer merges: `/sync` — back to an up-to-date `main`.
6. Review cadence: mechanical invariant checks run on every PR (CI); the
   `toad-reviewer` agent reviews what changed since the last `review/*` tag at
   the end of each milestone, with fresh context (D13). After a review, tag
   the merge commit `review/<milestone>`.

# croak — guide for AI agents

`croak` is a pre-execution gate for package installs, built for AI coding agents
first. It statically checks what an install (or an unfamiliar repo) would do
**before any of its code runs**, and explains its verdict so an agent can
self-correct.

- Plan and milestones: [ROADMAP.md](ROADMAP.md)
- Why things are the way they are: [docs/decisions.md](docs/decisions.md)

## Commands

```bash
nvm use            # Node 24 (see .nvmrc)
pnpm install
pnpm check         # lint + typecheck + test — run before every commit
pnpm format        # Biome autofix
pnpm build         # tsc -> dist/
```

Note: pnpm 12 does not accept `-s`.

## Invariants (never break these)

1. **croak never executes analyzed code.** No `eval`, `new Function`, `require`,
   `import()`, `child_process` on analyzed files or package contents. Install
   plans use `--package-lock-only` / `--lockfile-only` with `--ignore-scripts`.
2. **The LLM layer can only escalate.** Deterministic findings are the floor; an
   LLM result may raise severity but must never lower or remove a finding.
   Package contents are untrusted input to the LLM (prompt injection).
3. **Fail-closed for agents, warn for humans.** An LLM failure alone falls back
   to deterministic checks.
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
- Tests co-located: `foo.ts` → `foo.test.ts`. New detectors need eval cases.
- Fail fast with explicit error types; never swallow errors.
- Everything in the repo is in English: code, comments, commits, PRs, docs.

## Workflow

Small, reviewable steps. Never work for long stretches without checking in.

1. One task = one branch: `<type>/<milestone>-<topic>`
   (`feat/m1-eval-schema`, `fix/cli-unknown-flag`, `chore/claude-setup`).
2. Test first, then a small code change, then `pnpm check`.
3. Log notable decisions in `docs/decisions.md`.
4. `/ship` — commit, push, open a PR. **Never merge; the maintainer merges.**
5. After the maintainer merges: `/sync` — back to an up-to-date `main`.
6. `toad-reviewer` agent — project-specific review of a diff with fresh context.

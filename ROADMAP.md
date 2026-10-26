# croak 🐸 — Roadmap

> Croak before you install.

`croak` is a pre-execution gate for package installs. It stands between
"the package arrived" and "the package ran code on your machine", and it is
built for AI coding agents first: it blocks risky installs and explains why,
so the agent can correct itself.

Origin story: a 2013 diploma on elliptic-curve cryptography. In 2026 those
same curves sign every npm package with provenance.

## Principles

- **Never execute untrusted code.** Analysis is static. Plans are computed with
  `--package-lock-only` / `--lockfile-only` and `--ignore-scripts`.
- **Deterministic first, LLM second.** Rules are fast, free, and offline.
  The LLM layer is optional (BYOK) and **can only raise severity, never lower it**.
- **Fail-closed for agents, warn for humans.** If a check cannot complete,
  or the verdict is 🔴, an agent is blocked; on 🟡 the agent asks the user
  (D20); a human gets the report and decides. An LLM timeout alone
  falls back to deterministic checks.
- **Eval-driven.** No detector ships without eval cases. Every PR runs the eval.
- **Zero (or near-zero) runtime dependencies.** croak is itself an npm package,
  so it must not become the next compromised dependency. Publish only from CI
  with provenance.

## Threat model

### Assets

Secrets on the developer machine (`~/.ssh`, `~/.npmrc`, `.env`, wallets,
browser cookies), CI tokens, and the user's own published packages (worm spread).

### In scope (MVP)

| #   | Attacker                      | Example                                   | Detection                                                            |
| --- | ----------------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| A   | Hijacked maintainer account   | axios (2026-03), mastra (2026-06)         | New dependency, provenance dropped, new install script               |
| B   | Slopsquatting / typosquatting | `react-codeshift`, `unused-imports`       | Package missing or very new, name close to a popular one             |
| C   | Dependency confusion          | Public packages mirroring internal scopes | Public package with an internal-looking name                         |
| D   | Fake "test assignment" repo   | Contagious Interview campaign             | `croak repo`: autorun configs, obfuscation, suspicious build configs |
| E   | Attacks on croak itself       | Prompt injection in package contents      | LLM can only escalate; injection red-team eval set                   |

### Out of scope (stated honestly)

1. Delayed / runtime-only payloads (clean at install, malicious on `require` later).
2. Long-game maintainer takeovers (xz-utils style).
3. Compromise of the registry or Sigstore (trust boundary).
4. Malware already installed before croak ran.
5. Payloads targeted at a specific environment that are invisible statically.

## Milestones

### M0 — Foundation

- [x] Private GitHub repo
- [x] TypeScript strict, Vitest, lint
- [x] GitHub Actions CI
- [x] `docs/decisions.md` (decision log)

### M1 — Eval dataset first

- [x] Synthetic "test assignment" repos with harmless payloads, each detector with a benign twin
- [x] Mechanical invariant checks in CI (`pnpm invariants`)
- [x] Security model (`docs/security-model.md`) and snapshot resource limits
- [x] Eval runner + metrics: block/flag recall, false alarms, rule recall, latency (emoji + plain + JSON output)
- [x] Case format + first synthetic cases (null baseline: 0% recall)
- [x] Safety-floor detector `repo/unscanned`; regression guard against `eval/history`

### M2 — `croak repo` (static, offline)

- [x] `croak repo <path>`: human and JSON reports, exit codes, `info` severity
- [x] `repo/node-modules-present`: installed dependencies in a repo are one warning, not a wall of alarms
- [x] Lifecycle scripts in every `package.json` outside `node_modules` (incl. implicit `binding.gyp`), via a shell analyzer and code signals
- [x] IDE autorun (`.vscode/tasks.json` `runOn: folderOpen`, npm tasks, `dependsOn`)
- [x] Obfuscation (vs. minification) and hidden code (offscreen, below the fold, Trojan Source)
- [x] Suspicious code in build configs (`*.config.js`) — covered by the hidden-code and obfuscation detectors
- [x] Dangerous git config and hooks (`repo/git-config`)
- [x] Real-world corpus for false-alarm checks (`pnpm corpus`)
- [x] Fixes from the M2 review (D19 hardening, shell-parser evasions, decoys, report escaping, …)
- [x] Facts → signals → verdict model; `info` level that does not affect the verdict
- [x] ReDoS guard: detectors under pathological input with a time budget, own process + CI timeout
- [x] Spike: run analysis under `node --permission` (read-only, no child processes) — works; sandboxed scan in CI (D23)

### M3 — npm install plan + registry signals

- [x] Benign set: 61 pinned popular npm packages, `pnpm corpus:packages` (false-positive baseline: 0 blocks) — moved from M1
- [x] Install eval: six attacks with benign twins against a fake in-memory registry
- [x] Malicious set: references only — 15 real releases checked against OSV, mapped to the synthetic cases in `eval/README.md`; no tarballs in git, the eval stays synthetic (D29) — moved from M1
- [x] Threat model for running npm on untrusted input: isolated wrapper (temp dir with only manifest + lockfile, empty env and npm config, git disabled), offline CI proof that no script runs (D24)
- [x] Lockfile diff from a non-executing install plan: `croak plan` + `croak-install`, every new/changed version incl. transitive; lockfile signals (install scripts, non-registry sources, missing integrity)
- [x] Registry signals: package exists (did-you-mean hint in `croak-install`), release age (🟡 only), provenance dropped, new publisher, typo-squat names, brand-new packages; blocking combinations (D26)
- [x] Content signals: tarballs read in memory and verified against the lockfile; install-time vectors (scripts, `binding.gyp`, prebuilt binaries), hidden and obfuscated code; new deps and scripts vs the previous version (D27); recalibrated on eight popular packages (D28)

### M4 — Agent integration

- [x] Claude Code `PreToolUse` hook on install commands (`scripts/croak-hook.sh`, D32, D34)
- [x] Agent policy (D20): 🔴, "incomplete" and unchecked commands → deny; 🟡 → ask the user; 🟢 → silence
- [x] A nested install (`cd client && npm install`) triggers a fresh check of that install, in npm's own prefix
- [ ] Actionable feedback for the agent ("did you mean `jscodeshift`?") — deny/ask reasons ship; name suggestions do not yet
- [x] Verdict cache keyed by tarball sha512 + croak's code, so repeated installs stay fast in the hook (D33) — moved from M3 (D29)
- [x] Agent-command eval: 43 commands (caught 28/29, untouched 14/14)
- [ ] Not yet: npm workspaces, `npm-shrinkwrap.json` and private registries (denied for now, D34)

### M5 — LLM triage (BYOK, Haiku by default)

- [ ] Version-diff analysis only (cheap, focused)
- [ ] Escalate-only policy enforced in code
- [ ] Cost per verdict
- [ ] Ablation eval: rules vs rules+Haiku vs rules+stronger model
- [ ] Prompt-injection red-team set (target: 0 successful downgrades)

### M6 — pnpm adapter

- [ ] `EcosystemAdapter` for pnpm (lockfile + pnpm 10 script defaults)

### M7 — Crypto layer (the diploma chapter)

Three separate mechanisms, never merged into one "verified" badge:
- [ ] Registry signatures: the tarball is what the registry has
- [ ] Provenance (Sigstore): which workflow built it from which commit — signal on _changes_ (provenance dropped, repo or workflow changed); never lowers severity
- [ ] Tarball vs source at the attested commit: flag new executable entry points (install scripts, `bin`, native binaries), not ordinary build output

### M8 — npm release

- [ ] Open the repo — moved earlier: right after M2, marked early-stage (D21)
- [ ] Publish `@vola-trebla/croak` from CI with provenance (name checked for conflicts first, D22)
- [ ] Article: "From a 2013 ECC diploma to croak"

### Later

- Python (PyPI attestations / PEP 740, `setup.py`, `.pth`)
- Shared, signed verdicts between users

### Side quest

- [ ] `museum/`: port the 2013 C# ECC code to TypeScript as-is and break it with tests

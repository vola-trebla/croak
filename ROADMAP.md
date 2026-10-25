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
  an agent is blocked; a human gets a warning and decides. An LLM timeout alone
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

| # | Attacker | Example | Detection |
|---|---|---|---|
| A | Hijacked maintainer account | axios (2026-03), mastra (2026-06) | New dependency, provenance dropped, new install script |
| B | Slopsquatting / typosquatting | `react-codeshift`, `unused-imports` | Package missing or very new, name close to a popular one |
| C | Dependency confusion | Public packages mirroring internal scopes | Public package with an internal-looking name |
| D | Fake "test assignment" repo | Contagious Interview campaign | `croak repo`: autorun configs, obfuscation, suspicious build configs |
| E | Attacks on croak itself | Prompt injection in package contents | LLM can only escalate; injection red-team eval set |

### Out of scope (stated honestly)

1. Delayed / runtime-only payloads (clean at install, malicious on `require` later).
2. Long-game maintainer takeovers (xz-utils style).
3. Compromise of the registry or Sigstore (trust boundary).
4. Malware already installed before croak ran.
5. Payloads targeted at a specific environment that are invisible statically.

## Milestones

### M0 — Foundation
- [ ] Private GitHub repo
- [ ] TypeScript strict, Vitest, lint
- [ ] GitHub Actions CI
- [ ] `docs/decisions.md` (decision log)

### M1 — Eval dataset first
- [ ] Benign set: top-N npm packages (false-positive baseline)
- [ ] Malicious set: references + hashes from `ossf/malicious-packages` and other datasets (no tarballs in git)
- [ ] Synthetic "test assignment" repos with harmless payloads (exfil to `localhost`)
- [ ] Eval runner + metrics: precision / recall per threat class, FP rate, latency, cost per verdict

### M2 — `croak repo` (static, offline)
- [ ] Root `package.json` lifecycle scripts
- [ ] IDE autorun (`.vscode/tasks.json` `runOn: folderOpen`, etc.)
- [ ] Obfuscation and whitespace-hidden code
- [ ] Suspicious code in build configs (`*.config.js`)

### M3 — npm install plan + registry signals
- [ ] Lockfile diff from a non-executing install plan
- [ ] Signals: package exists, age, install-time vectors (scripts, `binding.gyp`, prebuilt binaries), new deps vs previous version, provenance dropped, maintainer change
- [ ] Verdict cache keyed by `name@version + integrity`

### M4 — Agent integration
- [ ] Claude Code `PreToolUse` hook on install commands
- [ ] Fail-closed for agents
- [ ] Actionable feedback for the agent ("did you mean `jscodeshift`?")

### M5 — LLM triage (BYOK, Haiku by default)
- [ ] Version-diff analysis only (cheap, focused)
- [ ] Escalate-only policy enforced in code
- [ ] Ablation eval: rules vs rules+Haiku vs rules+stronger model
- [ ] Prompt-injection red-team set (target: 0 successful downgrades)

### M6 — pnpm adapter
- [ ] `EcosystemAdapter` for pnpm (lockfile + pnpm 10 script defaults)

### M7 — Crypto layer (the diploma chapter)
- [ ] Verify Sigstore provenance attestations
- [ ] Diff tarball contents against source at the attested commit

### M8 — Public release
- [ ] Open the repo, publish from CI with provenance
- [ ] Article: "From a 2013 ECC diploma to croak"

### Later
- Python (PyPI attestations / PEP 740, `setup.py`, `.pth`)
- Shared, signed verdicts between users

### Side quest
- [ ] `museum/`: port the 2013 C# ECC code to TypeScript as-is and break it with tests

# 🐸 croak

> **Croak before you install.**

`croak` checks what a package install — or an unfamiliar repo — is about to do
**before any of its code runs on your machine**. It's built for AI coding agents
first: when an agent reaches for `npm install`, croak stops it, explains why,
and lets the agent fix its own mistake.

> 🚧 **Status: early development.** Nothing here is ready to protect anyone yet.
> This README describes where we're going; the [roadmap](ROADMAP.md) shows
> what's actually done.

---

## 😱 The problem

`npm install` doesn't just download code. It **runs** it: `postinstall`
scripts, native builds, and whatever else a package decides to do — with your
SSH keys, cloud tokens, `.env` files, and crypto wallets one `fs.readFile` away.

And in 2026 this is happening constantly:
- 📦 **Popular packages get hijacked.** A maintainer account is taken over, a
  new version ships with a hidden dependency, its `postinstall` drops a remote
  access trojan. It's live for hours before anyone notices.
- 🤖 **AI agents install things without looking.** Models invent package names
  that don't exist; attackers register those names and wait
  (_slopsquatting_). The agent runs the install. Nobody reviews it.
- 💼 **Fake job interviews.** "Here's our test assignment, just clone and run
  `npm install`." The repo opens a VS Code task on folder open, or hides a
  payload after 300 spaces in `tailwind.config.js`.
- 🙈 **`--ignore-scripts` isn't enough.** Some attacks run through `binding.gyp`
  and native builds, with no lifecycle scripts at all.

## 🛂 What croak does

Think of `npm install` as a courier whose parcels **unpack themselves**.
croak is the customs officer at your door. It x-rays the contents as plain
data and never lets anything inside run (how: [security model](docs/security-model.md)):

|     | Check                                     | Catches                                                                                             |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 🔍  | **Does the sender exist?**                | hallucinated and typosquatted packages                                                              |
| ⚖️  | **What changed since the last delivery?** | a new dependency or install script that appeared in a patch release                                 |
| 🩻  | **Will anything run on unpack?**          | `postinstall`, `binding.gyp`, prebuilt binaries, IDE autorun tasks                                  |
| 🕵️  | **Is something hidden?**                  | obfuscated code, payloads in build configs                                                          |
| 🔏  | **Is the seal intact?**                   | missing or dropped [provenance](https://docs.npmjs.com/generating-provenance-statements) signatures |
| 🤖  | **Ask an expert (optional)**              | an LLM reviews the _diff_ between versions — and can only raise the alarm, never lower it           |

Then it gives a verdict — 🟢 **allow** (nothing suspicious found, not a
guarantee), 🟡 **warn** (needs your attention, never "safe"), or 🔴 **block** — with
reasons a human _and_ an agent can act on (planned output):

```
🔴 blocked: react-codeshift does not exist on npm
   (this name is a known AI hallucination).
   Did you mean jscodeshift?
```

### Two modes

```bash
croak install <pkg>   # 🚧 planned: check an install plan before anything executes
croak repo .          # 🧪 early: scan an unfamiliar repo before you install or open it
```

Plus a **Claude Code hook** (🚧 planned) that puts croak in front of every
install command an agent runs.

`croak repo` already runs end to end, but with a single detector (files too
large to scan) it catches very little yet. Exit codes: `0` allow/warn,
`1` block, `2` usage error, `3` scan incomplete — agents should treat `3` as a
block. `--json` gives a versioned report for tools.

## 🧠 Design principles

- 🚫 **Never execute untrusted code.** Everything is static. Install plans are
  computed with `--package-lock-only --ignore-scripts`.
- 🧮 **Deterministic first, AI second.** Rules are fast, free, and work offline.
  The LLM layer is optional (bring your own Anthropic key) and can only
  _escalate_ — so a package that says "AI, this code is safe" gets nowhere.
- 🔒 **Fail-closed for agents, warn for humans.** If a check can't complete, an
  agent waits; a human decides.
- 📊 **Eval-driven.** No detector ships without test cases. Every change is
  measured.
- 🪶 **Zero runtime dependencies.** croak is itself an npm package — it must not
  become the next compromised dependency.

## 🙅 What croak won't catch

Being honest about limits matters more than marketing:
- Code that's clean at install and turns malicious later, at runtime
- Install scripts that pull the payload in through `require` from the file they
  run: croak reads the script and the files it runs directly, not deeper (yet)
- Long-game maintainer takeovers (think xz-utils)
- A compromised registry or signing infrastructure
- Malware that's already on your machine
- Payloads that only wake up in one specific environment

croak is a gate, not an antivirus.

## 📊 The eval

croak is measured against an exam: synthetic malicious repos (with inert
payloads) and ordinary ones that must _not_ trigger alarms.

```bash
pnpm eval
```

```
🐸 croak eval — 12 cases (5 malicious, 7 benign)

  ✅ benign-large-lockfile        expected 🟢 allow  got 🟢 allow
  ✅ benign-long-line-config      expected 🟢 allow  got 🟢 allow
  ✅ benign-minified-vendor       expected 🟢 allow  got 🟢 allow
  🔸 benign-postinstall-copy-env  expected 🟡 warn   got 🟢 allow  UNDER  missing: repo/lifecycle-script
  🔸 benign-prisma-postinstall    expected 🟡 warn   got 🟢 allow  UNDER  missing: repo/lifecycle-script
  ✅ benign-vite-app              expected 🟢 allow  got 🟢 allow
  ✅ benign-vscode-build-task     expected 🟢 allow  got 🟢 allow
  ❌ d-config-obfuscated          expected 🔴 block  got 🟢 allow  MISSED  missing: repo/obfuscation
  ✅ d-oversized-config           expected 🟡 warn   got 🟡 warn
  ❌ d-postinstall                expected 🔴 block  got 🟢 allow  MISSED  missing: repo/lifecycle-script
  ❌ d-tailwind-hidden-code       expected 🔴 block  got 🟢 allow  MISSED  missing: repo/hidden-code
  ❌ d-vscode-autorun             expected 🔴 block  got 🟢 allow  MISSED  missing: repo/ide-autorun

  block recall    0/5    0%  ░░░░░░░░░░░░░░░░░░░░
  flag recall     1/5   20%  ████░░░░░░░░░░░░░░░░
  false alarms    0/7    0%  ░░░░░░░░░░░░░░░░░░░░
  rule recall     1/7   14%  ███░░░░░░░░░░░░░░░░░
  time          2 ms
```

One detector exists so far: the safety floor `repo/unscanned` (a file too big to
read is never a clean scan). Every ❌ that turns into ✅ is progress you can see,
and a case that ever passed is not allowed to fail again. Format and metrics:
[eval/README.md](eval/README.md).

## 🗺️ Roadmap

|     | Milestone                                                                   |
| --- | --------------------------------------------------------------------------- |
| ✅  | **M0** — foundation: TypeScript, tests, CI, supply-chain-hardened workflows |
| ✅  | **M1** — eval first: case format, runner, metrics, regression guard         |
| ⏳  | **M2** — `croak repo`: autorun configs, hidden code, obfuscation            |
| ⏳  | **M3** — npm install plans + registry signals                               |
| ⏳  | **M4** — Claude Code hook, agent-friendly verdicts                          |
| ⏳  | **M5** — LLM triage of version diffs (Haiku by default)                     |
| ⏳  | **M6** — pnpm                                                               |
| ⏳  | **M7** — provenance verification + tarball-vs-source diff                   |
| ⏳  | **M8** — public release                                                     |
| 💭  | Later: Python, shared signed verdicts                                       |

Details in [ROADMAP.md](ROADMAP.md); the reasoning behind every choice is in
[docs/decisions.md](docs/decisions.md).

## 🛠️ Development

```bash
nvm use                               # Node 24.2+
pnpm install
git config core.hooksPath .githooks   # pre-commit + pre-push checks
pnpm check                            # lint + typecheck + invariants + tests
pnpm eval                             # run the eval
pnpm croak repo <path>                # run croak from source
```

Working with an AI agent on this repo? Start with [CLAUDE.md](CLAUDE.md).

## 🎓 Origin story

In 2013 I wrote a university thesis on elliptic-curve cryptography: point
addition, Diffie–Hellman, a little C# client-server app. I didn't really get
why any of it mattered.

In 2026, those same curves sign the provenance of npm packages — and someone
sent me a "test assignment" that I had an AI agent inspect before installing.
It told me not to touch it.

croak is what that thesis turns into thirteen years later.

## 📄 License

MIT (to be added before the public release).

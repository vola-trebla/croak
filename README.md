# 🐸 croak

> **Croak before you install.**

`croak` checks what a package install — or an unfamiliar repo — is about to do
**before any of its code runs on your machine**. It's built for AI coding agents
first: when an agent reaches for `npm install`, croak stops it, explains why,
and lets the agent fix its own mistake.

> 🚧 **Status: early development.** `croak repo` and the npm install check
> (`croak-install`) work end to end; the agent hook, the LLM layer and an npm
> release are not there yet. Use it, but don't rely on it as your only line of
> defense. The [roadmap](ROADMAP.md) shows what's done.

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

|     | Check                                     | Catches                                                                                                                       |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 🔍  | **Does the sender exist?**                | hallucinated and typosquatted packages                                                                                        |
| ⚖️  | **What changed since the last delivery?** | a new dependency or install script that appeared in a patch release                                                           |
| 🩻  | **Will anything run on unpack?**          | `postinstall`, `binding.gyp`, prebuilt binaries, IDE autorun tasks                                                            |
| 🕵️  | **Is something hidden?**                  | obfuscated code, payloads in build configs                                                                                    |
| 🔏  | **Is the seal intact?**                   | a tarball that doesn't match the lockfile hash, dropped [provenance](https://docs.npmjs.com/generating-provenance-statements) |
| 🤖  | **Ask an expert (optional)**              | an LLM reviews the _diff_ between versions — and can only raise the alarm, never lower it                                     |

Then it gives a verdict — 🟢 **allow** (nothing suspicious found, not a
guarantee), 🟡 **warn** (needs your attention, never "safe"), or 🔴 **block** — with
reasons a human _and_ an agent can act on:

```
$ croak-install jscodeshift-react-transform
croak-install: a requested package does not exist on npm. Check the name:
AI agents often invent plausible package names, and attackers register them.

$ croak-install esbuild
croak plan - WARN
  WARN   esbuild@0.28.2/package.json:10  repo/lifecycle-script
           postinstall runs `node install.js` on install: network (install.js:93), process (install.js:95), decode (install.js:166)
  INFO   package-lock.json  install/other-platform
           25 package(s) built for other platforms not checked: npm will not install them on darwin-arm64
```

### Two modes

```bash
croak-install <pkg>   # plan an npm install, check it before anything executes
croak repo .          # scan an unfamiliar repo before you install or open it
```

Plus a **Claude Code hook** (🚧 planned, M4) that puts croak in front of every
install command an agent runs.

**`croak-install`** has npm resolve the install with `--package-lock-only
--ignore-scripts` in an isolated temp directory (your project's lockfile is
not touched), then `croak plan` checks every new or changed version,
transitive ones included: the lockfile (install scripts, sources, integrity),
the registry (release age, provenance, publisher, look-alike names, brand-new
packages and dependencies), and the package contents, downloaded and verified
against the lockfile hash and read in memory, never extracted or run.

**`croak repo`** runs seven detectors: install scripts, VS Code autorun tasks,
hidden code, obfuscation, dangerous git config, committed `node_modules`, and
files too large to scan.

Exit codes: `0` allow/warn, `1` block, `2` usage error, `3` check incomplete —
agents should treat `3` as a block. `--json` gives a versioned report for tools.

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
- Payloads in library code that run only when your app calls it, not at install
  (chalk and debug, 2025): only the content checks can see those
- Long-game maintainer takeovers (think xz-utils), or a decoy release published
  more than a week before the real attack
- A compromised registry or signing infrastructure
- Malware that's already on your machine
- Payloads that only wake up in one specific environment

croak is a gate, not an antivirus.

## 📊 The eval

croak is measured against an exam: synthetic malicious repos and installs
(with inert payloads, served from a fake registry for installs) and ordinary
ones that must _not_ trigger alarms. Each install case maps to a real attack
(axios 2026, Shai-Hulud 2025, ua-parser-js 2021…), checked against OSV.

```bash
pnpm eval
```

```
🐸 croak eval — 46 cases (23 malicious, 23 benign)
  …
  block recall  18/23   78%  ████████████████░░░░
  flag recall   23/23  100%  ████████████████████
  false alarms   0/23    0%  ░░░░░░░░░░░░░░░░░░░░
  rule recall   33/33  100%  ████████████████████
```

Synthetic cases are written by us, so two more runs check the noise on code we
did not write: 13 pinned real-world repositories (`pnpm corpus`) and 61 pinned
popular npm packages (`pnpm corpus:packages`: 0 blocks; the warnings are
fresh releases and real install scripts). A case that ever passed is not
allowed to fail again. Format, metrics and the real attacks behind each case:
[eval/README.md](eval/README.md).

## 🗺️ Roadmap

|     | Milestone                                                                   |
| --- | --------------------------------------------------------------------------- |
| ✅  | **M0** — foundation: TypeScript, tests, CI, supply-chain-hardened workflows |
| ✅  | **M1** — eval first: case format, runner, metrics, regression guard         |
| ✅  | **M2** — `croak repo`: autorun configs, hidden code, obfuscation            |
| ✅  | **M3** — npm install plans, registry and package-content signals            |
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
pnpm corpus:fetch && pnpm corpus      # false-alarm check on real repos (network)
pnpm corpus:packages                  # false-alarm check on real npm packages (network)
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

[MIT](LICENSE). Found a way around croak? See [SECURITY.md](SECURITY.md).

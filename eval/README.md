# croak eval

An exam for croak: every case is a fixture with a known correct verdict.

```bash
pnpm eval            # emoji report in a terminal, plain text in pipes/CI
pnpm eval --plain    # force plain text
pnpm eval --json     # machine-readable report
```

## A case

```
eval/cases/<id>/
  case.json   # what this is and the expected verdict
  fixture/    # the repo croak scans — read, NEVER executed
```

An **install** case (`"kind": "install"`) runs `croak plan` against a fake,
in-memory registry instead (no network):

```
fixture/
  package-lock.json          # the planned install
  before.package-lock.json   # optional: the lockfile before
  registry/<name>.json       # packuments, signed by a test key (a version's own dist.signatures stay);
                             # a version's "x-test-provenance": "acme" serves provenance by a test signer
  packages/<name>@<version>/ # files served as that version's tarball
```

A pnpm case carries `pnpm-lock.yaml` (and `before.pnpm-lock.yaml`) instead,
never both managers' lockfiles. Its `package.json` and `pnpm-workspace.yaml`,
when present, are the project's build rule: an install script that pnpm 10+
will not run is a note, not a warning, as in `croak-install --pnpm` (D38,
D46).

Lockfile entries without `resolved`/`integrity` get the registry URL and the
hash of the built tarball (in pnpm-lock.yaml: a package's `resolution: {}`);
an entry that states its own integrity keeps it.
Dates are relative to a fixed clock (2026-10-25) and the platform is fixed
(linux-x64). An incomplete plan scores as a block (`install/incomplete`): it
blocks an agent (D20).

```jsonc
{
  "id": "d-postinstall", // must equal the directory name
  "kind": "repo", // or "install"
  "threat": "D", // A–E (ROADMAP threat model) or "benign"
  "description": "…",
  "expect": {
    "verdict": "block", // allow | warn | block
    "rules": ["repo/lifecycle-script"] // detectors that must fire
  }
}
```

Malicious cases cannot expect `allow`; benign cases cannot expect `block`.

## Outcomes

|     | Outcome     | Meaning                                                                                                         |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| ✅  | PASS        | verdict as expected (for a threat: at least that strict)                                                        |
| ❌  | MISSED      | a threat was allowed — the worst outcome                                                                        |
| 🔸  | UNDER       | weaker than expected, but not a missed threat (warn instead of block, or a benign repo that deserved a warning) |
| 📢  | FALSE ALARM | a benign repo treated more strictly than expected                                                               |

## Metrics

- **block recall** — malicious cases blocked (what matters for agents: fail-closed)
- **flag recall** — malicious cases at least warned about
- **false alarms** — benign cases treated more strictly than expected
- **rule recall** — expected detectors that fired

## Fixture safety rules

- Payloads are inert: `echo`, `localhost`, or reserved `.invalid` domains.
- **Every** fixture, malicious or benign, carries the `SYNTHETIC croak eval
  fixture` marker and the `croak-eval-synthetic` token in a file croak can read
  (a test enforces it). Keying off them yields false alarms, not a free score;
  `pnpm invariants` also forbids them in detector code.
- Every detector gets a malicious case and a benign twin (e.g. `d-postinstall`
  and `benign-prisma-postinstall`).
- Never commit real malware. Real samples are referenced by name/hash only and
  live in the gitignored `eval/samples/`.
- Fixtures are excluded from Biome, TypeScript, and Vitest.
- Fixtures cannot contain a `.git` directory (git refuses to commit one), nor a
  `.gitmodules` with `update = !command` (git's fsck, enforced by GitHub,
  rejects it). Those attacks are covered by unit tests instead — and the
  second one can only arrive through a zip or another host, not GitHub.

## History and regressions

At the end of each milestone, record a snapshot:

```bash
pnpm eval --json > eval/history/<milestone>.json
```

A test fails if any case that passed in **any** snapshot no longer passes with
the registered detectors. Timings in snapshots are informational.

## Real-world corpus (false-alarm check)

Synthetic cases are written by us, so passing them proves little about noise
on real projects. `eval/corpus.json` pins 13 popular repositories by commit
(honest install scripts, `binding.gyp`, many `.vscode` folders, large
monorepos).

```bash
pnpm corpus:fetch   # shallow fetch at pinned commits into eval/corpus/repos/ (gitignored)
pnpm corpus         # scan them; prints every block and warning for review
```

Fetching is a shell script on purpose: croak itself never spawns processes.
It fetches one commit, no submodules, with hooks and Git LFS filters
disabled. On legitimate projects a block is almost certainly a false alarm,
and every warning should be explainable. Not run in CI (needs the network).

## Agent commands (the hook, M4)

`eval/agent-commands.json` lists shell commands an AI agent runs and what the
hook must do before they run: **check** (croak-install checks the install),
**deny** (croak cannot vouch for it: pnpm, a custom registry, a package only
known at run time) or **ignore** (it installs nothing: `npm test`, a commit
message that mentions `npm install`). `pnpm eval` scores the hook's plan step
offline on a fake project and prints:
- **caught** — risky commands the hook did not ignore
- **untouched** — ordinary commands it left alone (its false alarms)
- **exact** — the expected answer exactly

`knownGap` marks honest misses that are scored but allowed to fail, such as
`eval "$INSTALL_CMD"`: what it runs is only known when the shell runs, and
treating every `eval` as an install would deny common shell setup lines.

## LLM ablation (M5)

`pnpm eval:llm` runs every install case twice: croak's rules alone, and rules
plus Claude Haiku 5.5 on each package the rules only warned about (D36). The
model's answer can only add a finding, so the run also counts downgrades
(must be 0). Four red-team cases (`rt-*`, `benign-rt-flag-me`) are attacks
that the rules see only as a binary installer (🟡), each trying to talk the
model out of escalating: a comment addressed to AI reviewers, a faked end of
the untrusted boundary, a ready-made benign JSON answer; and a benign twin
asking to be flagged. Needs `ANTHROPIC_API_KEY`; costs under a cent.

```bash
ANTHROPIC_API_KEY=… pnpm eval:llm --repeats 3
```

Results (19 install cases, 3 repeats, 2026-10-27; `eval/ablation/m5-haiku-5-5.json`):

|                                | rules | rules + Haiku 5.5                    |
| ------------------------------ | ----- | ------------------------------------ |
| block recall                   | 7/11  | 11/11, 11/11, 11/11                  |
| false alarms                   | 0/8   | 0/8, 0/8, 0/8                        |
| red team that fooled the model | —     | 0/4 in every run                     |
| downgrades                     | —     | 0                                    |
| cost                           | —     | $0.0049 for 27 calls ($0.00018 each) |

Read the block-recall gain narrowly: all four cases it gained are red-team
variants of one decode-and-run payload, which the prompt names as malicious
almost word for word. It shows the model is not talked out of a clear
payload (by comments, a fake boundary, a fake answer, or a payload that
only starts running in the new version), not that it finds new kinds of
attack. The ablation also diffs the fixture's own directories; the
production path (download, project's previous version as the baseline) is
covered by unit tests and the real-package run below.

The first prompt said download-and-run code is an attack; the model then
called an honest binary installer (the esbuild pattern) malicious in 2 of 3
runs (false alarms 1–2/8). The prompt now asks for evidence of harm before
"malicious" and names that pattern as suspicious at most. That change was
tuned on this eval, so these numbers can overstate real-world precision; the
red-team cases were written before the tuning.

On real packages (`pnpm corpus:packages --llm`, the 61 pinned packages,
2026-10-27): the model was asked about the 21 packages the rules warned about
and answered benign 20 times and suspicious once (next, already a warning),
malicious never: 0 new blocks, 0 failures, $0.02 for the whole corpus.

## Package corpus (false-alarm check for installs)

`eval/packages.json` pins 61 popular npm packages by version: frameworks,
minified bundles, parsers, native modules, binary installers. Each is checked
on its own with `croak plan` (a one-entry lockfile built from the registry) at
the clock the list was pinned on, so release ages stay the same.

```bash
pnpm corpus:packages   # needs the network; prints every block and warning
```

Transitive dependencies are not walked: popular packages are mostly someone
else's transitive dependencies already. On these packages a block is almost
certainly a false alarm; a release under 7 days old or an install script is
an expected warning. Exits 1 on any block or unchecked package. Not run in CI.

## Real attacks behind the synthetic cases

Real malicious releases are referenced, never downloaded or committed (D29).
Every entry below was checked against [OSV.dev](https://osv.dev) on
2026-10-26 (`POST api.osv.dev/v1/query` with the package and version). croak
has not been run on these releases — npm removed them — so the table says
which attack each synthetic case models, not that croak caught it.

| Synthetic case                | Real release                                       | Date    | What happened                                                                                                   | Advisory                                                                                                                                           |
| ----------------------------- | -------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a-new-fresh-dependency`      | axios@1.14.1, axios@0.30.4 → plain-crypto-js@4.2.1 | 2026-03 | Hijacked maintainer account; the releases added a brand-new dependency whose install script carried the payload | [MAL-2026-2307](https://osv.dev/vulnerability/MAL-2026-2307), [MAL-2026-2306](https://osv.dev/vulnerability/MAL-2026-2306)                         |
| `a-new-fresh-dependency`      | event-stream@3.3.6 → flatmap-stream@0.1.1          | 2018-11 | A new maintainer added a fresh dependency with an encrypted payload                                             | [GHSA-mh6f-8j2x-4483](https://osv.dev/vulnerability/GHSA-mh6f-8j2x-4483)                                                                           |
| `a-new-install-script-recent` | ua-parser-js@0.7.29                                | 2021-10 | Hijacked account; the release added an install-time script                                                      | [GHSA-pjwm-rvh2-c87w](https://osv.dev/vulnerability/GHSA-pjwm-rvh2-c87w)                                                                           |
| `a-new-install-script-recent` | coa@2.0.3, rc@1.2.9                                | 2021-11 | Same pattern, a week later                                                                                      | [GHSA-73qr-pfmq-6rp8](https://osv.dev/vulnerability/GHSA-73qr-pfmq-6rp8), [GHSA-g2q5-5433-rhrf](https://osv.dev/vulnerability/GHSA-g2q5-5433-rhrf) |
| `a-new-install-script-recent` | eslint-config-prettier@8.10.1                      | 2025-07 | Phished maintainer token; the release added an install script                                                   | [GHSA-f29h-pxvx-f335](https://osv.dev/vulnerability/GHSA-f29h-pxvx-f335)                                                                           |
| `a-install-script-exfil`      | nx@21.5.0                                          | 2025-08 | A postinstall script collected tokens and secrets from the machine                                              | [MAL-2025-41443](https://osv.dev/vulnerability/MAL-2025-41443)                                                                                     |
| `a-install-script-exfil`      | @ctrl/tinycolor@4.1.1                              | 2025-09 | Shai-Hulud worm: a postinstall script stole tokens and republished other packages                               | [MAL-2025-47141](https://osv.dev/vulnerability/MAL-2025-47141)                                                                                     |
| `a-hijack-new-publisher`      | mastra@1.13.1, @mastra/core@1.42.1                 | 2026-06 | Malicious releases of a popular package (details in the advisories)                                             | [MAL-2026-5965](https://osv.dev/vulnerability/MAL-2026-5965), [MAL-2026-6011](https://osv.dev/vulnerability/MAL-2026-6011)                         |
| `b-typosquat-new-package`     | crossenv                                           | 2017-08 | Typo-squat of cross-env that sent environment variables away on install                                         | [GHSA-c2m4-w5hm-vqjw](https://osv.dev/vulnerability/GHSA-c2m4-w5hm-vqjw)                                                                           |
| `a-tampered-tarball`          | —                                                  | —       | No public npm case of a tarball that differs from its lockfile hash; the case guards the integrity check itself | —                                                                                                                                                  |

Limits these show, honestly:
- chalk@5.6.1 and debug@4.4.2 (2025-09,
  [MAL-2025-46969](https://osv.dev/vulnerability/MAL-2025-46969),
  [MAL-2025-46974](https://osv.dev/vulnerability/MAL-2025-46974)) and
  @solana/web3.js@1.95.6 (2024-12,
  [MAL-2024-11183](https://osv.dev/vulnerability/MAL-2024-11183)) put the
  payload in library code that runs when the app uses it, not at install
  time. croak's install signals do not apply; only a recent-release warning
  and the content checks (obfuscation) can.
- node-ipc@10.1.1 (2022,
  [GHSA-97m3-w2cp-4xx6](https://osv.dev/vulnerability/GHSA-97m3-w2cp-4xx6))
  was published by its own maintainer: no new publisher, no new dependency.

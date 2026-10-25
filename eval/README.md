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

```jsonc
{
  "id": "d-postinstall", // must equal the directory name
  "kind": "repo", // "install" arrives in M3
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
- Fixtures cannot contain a `.git` directory (git refuses to commit one);
  `.git` attacks are tested with generated directories in unit tests.

## History and regressions

At the end of each milestone, record a snapshot:

```bash
pnpm eval --json > eval/history/<milestone>.json
```

A test fails if any case that passed in **any** snapshot no longer passes with
the registered detectors. Timings in snapshots are informational.

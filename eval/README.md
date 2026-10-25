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

|     | Outcome     | Meaning                                                   |
| --- | ----------- | --------------------------------------------------------- |
| ✅  | PASS        | verdict as expected                                       |
| ❌  | MISSED      | a threat was allowed — the worst outcome                  |
| 🔸  | UNDER       | flagged, but weaker than expected (warn instead of block) |
| 📢  | FALSE ALARM | stricter than expected, e.g. a benign repo blocked        |

## Metrics

- **block recall** — malicious cases blocked (what matters for agents: fail-closed)
- **flag recall** — malicious cases at least warned about
- **false alarms** — benign cases treated more strictly than expected
- **rule recall** — expected detectors that fired

## Fixture safety rules

- Payloads are inert: `echo`, `localhost`, or reserved `.invalid` domains.
- Mark payload files with a `SYNTHETIC croak eval fixture` comment.
- **Detectors must never key off that marker** — that would cheat the eval.
- Every detector gets a malicious case and a benign twin (e.g. `d-postinstall`
  and `benign-prisma-postinstall`).
- Never commit real malware. Real samples are referenced by name/hash only and
  live in the gitignored `eval/samples/`.
- Fixtures are excluded from Biome, TypeScript, and Vitest.

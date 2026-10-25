import { describe, expect, it } from "vitest";
import type { EvalCase } from "./case.ts";
import { computeMetrics, outcomeOf, scoreCase } from "./score.ts";

describe("outcomeOf", () => {
  it.each([
    // threats: stricter than expected is fine, allowing is the worst
    ["D", "block", "block", "pass"],
    ["D", "warn", "block", "pass"],
    ["D", "block", "allow", "missed"],
    ["D", "warn", "allow", "missed"],
    ["D", "block", "warn", "under"],
    // benign: stricter than expected is a false alarm, never "missed"
    ["benign", "allow", "allow", "pass"],
    ["benign", "allow", "warn", "false-alarm"],
    ["benign", "warn", "block", "false-alarm"],
    ["benign", "warn", "allow", "under"],
  ] as const)(
    "%s: expected %s, got %s → %s",
    (threat, expected, got, outcome) => {
      expect(outcomeOf(threat, expected, got)).toBe(outcome);
    },
  );
});

const makeCase = (
  id: string,
  threat: EvalCase["threat"],
  verdict: EvalCase["expect"]["verdict"],
  rules: string[],
): EvalCase => ({
  id,
  kind: "repo",
  threat,
  description: id,
  expect: { verdict, rules },
  fixtureDir: "/fixture",
});

describe("scoreCase", () => {
  it("reports missing rules and dedupes fired rules", () => {
    const result = scoreCase(
      makeCase("d", "D", "block", ["r/a", "r/b"]),
      "block",
      ["r/a", "r/a"],
      3,
    );
    expect(result).toMatchObject({
      outcome: "pass",
      firedRules: ["r/a"],
      missingRules: ["r/b"],
    });
  });
});

describe("computeMetrics", () => {
  it("computes recall, false alarms, and rule recall", () => {
    const results = [
      scoreCase(makeCase("m1", "D", "block", ["r/a"]), "block", ["r/a"], 1),
      scoreCase(makeCase("m2", "D", "block", ["r/b"]), "warn", [], 1),
      scoreCase(makeCase("m3", "A", "block", ["r/c"]), "allow", [], 1),
      scoreCase(makeCase("b1", "benign", "allow", []), "warn", [], 1),
      scoreCase(makeCase("b2", "benign", "warn", ["r/a"]), "warn", ["r/a"], 1),
    ];
    expect(computeMetrics(results)).toEqual({
      cases: 5,
      malicious: 3,
      benign: 2,
      blockRecall: { hit: 1, total: 3 },
      flagRecall: { hit: 2, total: 3 },
      falseAlarms: { hit: 1, total: 2 },
      ruleRecall: { hit: 2, total: 4 },
    });
  });

  it("uses zero totals instead of NaN when a group is empty", () => {
    expect(computeMetrics([]).blockRecall).toEqual({ hit: 0, total: 0 });
  });
});

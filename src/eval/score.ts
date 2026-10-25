import { type Verdict, verdictRank } from "../verdict.ts";
import type { EvalCase, Threat } from "./case.ts";

/**
 * pass        — verdict as expected
 * missed      — threat expected to be flagged, croak allowed it (the worst outcome)
 * under       — flagged, but weaker than expected (warn instead of block)
 * false-alarm — stricter than expected (e.g. blocked a benign repo)
 */
export type Outcome = "pass" | "missed" | "under" | "false-alarm";

export interface CaseResult {
  readonly id: string;
  readonly threat: Threat;
  readonly expected: Verdict;
  readonly got: Verdict;
  readonly outcome: Outcome;
  readonly expectedRules: readonly string[];
  readonly firedRules: readonly string[];
  readonly missingRules: readonly string[];
  readonly durationMs: number;
}

/** hit out of total; total 0 means "not applicable", never NaN. */
export interface Ratio {
  readonly hit: number;
  readonly total: number;
}

export interface Metrics {
  readonly cases: number;
  readonly malicious: number;
  readonly benign: number;
  /** Malicious cases that croak blocked — the metric for agents (fail-closed). */
  readonly blockRecall: Ratio;
  /** Malicious cases that croak at least warned about. */
  readonly flagRecall: Ratio;
  /** Benign cases where croak was stricter than expected. */
  readonly falseAlarms: Ratio;
  /** Expected rule ids that fired, across all cases. */
  readonly ruleRecall: Ratio;
}

export function outcomeOf(expected: Verdict, got: Verdict): Outcome {
  const diff = verdictRank(got) - verdictRank(expected);
  if (diff === 0) return "pass";
  if (diff > 0) return "false-alarm";
  return got === "allow" ? "missed" : "under";
}

export function scoreCase(
  evalCase: EvalCase,
  got: Verdict,
  firedRules: readonly string[],
  durationMs: number,
): CaseResult {
  const fired = [...new Set(firedRules)].sort();
  return {
    id: evalCase.id,
    threat: evalCase.threat,
    expected: evalCase.expect.verdict,
    got,
    outcome: outcomeOf(evalCase.expect.verdict, got),
    expectedRules: evalCase.expect.rules,
    firedRules: fired,
    missingRules: evalCase.expect.rules.filter((rule) => !fired.includes(rule)),
    durationMs,
  };
}

const ratio = (hit: number, total: number): Ratio => ({ hit, total });

export function computeMetrics(results: readonly CaseResult[]): Metrics {
  const malicious = results.filter((r) => r.threat !== "benign");
  const benign = results.filter((r) => r.threat === "benign");
  const expectedRules = results.reduce(
    (sum, r) => sum + r.expectedRules.length,
    0,
  );
  const missingRules = results.reduce(
    (sum, r) => sum + r.missingRules.length,
    0,
  );

  return {
    cases: results.length,
    malicious: malicious.length,
    benign: benign.length,
    blockRecall: ratio(
      malicious.filter((r) => r.got === "block").length,
      malicious.length,
    ),
    flagRecall: ratio(
      malicious.filter((r) => r.got !== "allow").length,
      malicious.length,
    ),
    falseAlarms: ratio(
      benign.filter((r) => r.outcome === "false-alarm").length,
      benign.length,
    ),
    ruleRecall: ratio(expectedRules - missingRules, expectedRules),
  };
}

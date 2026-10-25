import { performance } from "node:perf_hooks";
import { type RepoDetector, scanRepo } from "../detectors/index.ts";
import { snapshotRepo } from "../repo-snapshot.ts";
import { aggregate } from "../verdict.ts";
import type { EvalCase } from "./case.ts";
import type { Report } from "./render.ts";
import { type CaseResult, computeMetrics, scoreCase } from "./score.ts";

/** Runs detectors over every case fixture. Fixtures are read, never executed. */
export function runEval(
  cases: readonly EvalCase[],
  detectors?: readonly RepoDetector[],
): Report {
  const started = performance.now();
  const results: CaseResult[] = cases.map((evalCase) => {
    const caseStarted = performance.now();
    const findings = scanRepo(snapshotRepo(evalCase.fixtureDir), detectors);
    return scoreCase(
      evalCase,
      aggregate(findings),
      findings.map((finding) => finding.ruleId),
      performance.now() - caseStarted,
    );
  });
  return {
    results,
    metrics: computeMetrics(results),
    durationMs: performance.now() - started,
  };
}

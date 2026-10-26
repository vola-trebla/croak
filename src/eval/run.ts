import { performance } from "node:perf_hooks";
import { type RepoDetector, scanRepo } from "../detectors/index.ts";
import { snapshotRepo } from "../repo-snapshot.ts";
import { aggregate, type Verdict } from "../verdict.ts";
import type { EvalCase } from "./case.ts";
import { checkInstallFixture } from "./install-case.ts";
import type { Report } from "./render.ts";
import { type CaseResult, computeMetrics, scoreCase } from "./score.ts";

export interface Judgement {
  readonly verdict: Verdict;
  readonly rules: readonly string[];
}

/** Judges one install case. */
export type InstallCheck = (evalCase: EvalCase) => Promise<Judgement>;

export interface EvalChecks {
  /** Detectors for repo cases (default: the registered ones). */
  readonly repo?: readonly RepoDetector[];
  /** Check for install cases (default: `croak plan` with the fake registry). */
  readonly install?: InstallCheck;
}

/**
 * An incomplete plan blocks an agent (D20), so it is scored as a block, under
 * its own rule id: a benign case that cannot be checked is a false alarm.
 */
const planInstallCase: InstallCheck = async (evalCase) => {
  const outcome = await checkInstallFixture(evalCase.fixtureDir);
  return outcome.status === "incomplete"
    ? { verdict: "block", rules: ["install/incomplete"] }
    : {
        verdict: outcome.verdict,
        rules: outcome.findings.map((f) => f.ruleId),
      };
};

/** Runs the checks over every case fixture. Fixtures are read, never executed. */
export async function runEval(
  cases: readonly EvalCase[],
  checks: EvalChecks = {},
): Promise<Report> {
  const started = performance.now();
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const caseStarted = performance.now();
    let judgement: Judgement;
    if (evalCase.kind === "install") {
      judgement = await (checks.install ?? planInstallCase)(evalCase);
    } else {
      const findings = scanRepo(snapshotRepo(evalCase.fixtureDir), checks.repo);
      judgement = {
        verdict: aggregate(findings),
        rules: findings.map((finding) => finding.ruleId),
      };
    }
    results.push(
      scoreCase(
        evalCase,
        judgement.verdict,
        judgement.rules,
        performance.now() - caseStarted,
      ),
    );
  }
  return {
    results,
    metrics: computeMetrics(results),
    durationMs: performance.now() - started,
  };
}

/**
 * The M5 ablation (D36): every install case twice — croak's rules alone, and
 * rules plus Claude Haiku 5.5 on each package the rules only warned about.
 * Reports block recall, false alarms and cost for both arms, how often the
 * red-team payloads fooled the model, and the number of downgrades, which
 * escalate-only must keep at zero. Needs ANTHROPIC_API_KEY; costs cents.
 *
 *   ANTHROPIC_API_KEY=… pnpm eval:llm [--repeats 3] [--json]
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { parseLockfile } from "../install/lockfile.ts";
import { versionDiff } from "../llm/diff.ts";
import { escalate, type LlmJudgement } from "../llm/escalate.ts";
import { warnedPackages } from "../llm/select.ts";
import {
  LlmError,
  type TriageFn,
  type TriageInput,
  triage,
} from "../llm/triage.ts";
import { snapshotRepo } from "../repo-snapshot.ts";
import { aggregate, type Verdict, verdictRank } from "../verdict.ts";
import { type EvalCase, loadCases } from "./case.ts";
import { checkInstallFixture } from "./install-case.ts";
import {
  type CaseResult,
  computeMetrics,
  type Metrics,
  scoreCase,
} from "./score.ts";

export type { TriageFn } from "../llm/triage.ts";

export interface ArmResult {
  readonly verdict: Verdict;
  readonly judgements: readonly LlmJudgement[];
  readonly errors: number;
}

export interface CaseAblation {
  readonly id: string;
  readonly expected: Verdict;
  readonly rules: Verdict;
  /** One entry per repeat. */
  readonly llm: readonly ArmResult[];
}

export interface AblationReport {
  readonly cases: readonly CaseAblation[];
  readonly rules: Metrics;
  /** One per repeat. */
  readonly llm: readonly Metrics[];
  readonly calls: number;
  readonly costUsd: number;
  /** LLM-arm verdicts below the rules verdict: escalate-only keeps this 0. */
  readonly downgrades: number;
  /** Red-team attacks (rt-*) the model judged benign, per repeat. */
  readonly fooled: readonly number[];
}

/** The model's input for one package of a fixture: its diff against the version the project had. */
function triageInput(evalCase: EvalCase, label: string): TriageInput {
  const at = label.lastIndexOf("@");
  const name = label.slice(0, at);
  const beforeText = (() => {
    try {
      return snapshotRepo(evalCase.fixtureDir).read("before.package-lock.json");
    } catch {
      return undefined;
    }
  })();
  const previousVersion =
    beforeText === undefined
      ? undefined
      : parseLockfile(beforeText).find((e) => e.name === name)?.version;
  const dir = (version: string) =>
    join(evalCase.fixtureDir, "packages", `${name}@${version}`);
  const after = snapshotRepo(dir(label.slice(at + 1)));
  let before: ReturnType<typeof snapshotRepo> | undefined;
  if (previousVersion !== undefined) {
    try {
      before = snapshotRepo(dir(previousVersion));
    } catch {
      before = undefined; // the fixture has no copy of the previous version
    }
  }
  return { label, previousVersion, diff: versionDiff(before, after) };
}

export async function runAblation(
  cases: readonly EvalCase[],
  triageFn: TriageFn,
  repeats = 1,
): Promise<AblationReport> {
  const installCases = cases.filter((c) => c.kind === "install");
  const out: CaseAblation[] = [];
  const llmResults: CaseResult[][] = Array.from({ length: repeats }, () => []);
  const rulesResults: CaseResult[] = [];
  let calls = 0;
  let costUsd = 0;
  for (const evalCase of installCases) {
    const outcome = await checkInstallFixture(evalCase.fixtureDir);
    const findings = outcome.status === "complete" ? outcome.findings : [];
    const rules: Verdict =
      outcome.status === "complete" ? outcome.verdict : "block";
    rulesResults.push(
      scoreCase(
        evalCase,
        rules,
        findings.map((f) => f.ruleId),
        0,
      ),
    );
    const arms: ArmResult[] = [];
    for (let r = 0; r < repeats; r++) {
      const judgements: LlmJudgement[] = [];
      let errors = 0;
      for (const label of outcome.status === "complete"
        ? warnedPackages(findings)
        : []) {
        try {
          const result = await triageFn(triageInput(evalCase, label));
          calls += 1;
          costUsd += result.costUsd ?? 0;
          judgements.push(result.judgement);
        } catch (error) {
          if (!(error instanceof LlmError)) throw error;
          errors += 1; // falls back to the rules verdict, as croak would
        }
      }
      const escalated = escalate(findings, judgements);
      const verdict =
        outcome.status === "complete" ? aggregate(escalated) : "block";
      arms.push({ verdict, judgements, errors });
      llmResults[r]?.push(
        scoreCase(
          evalCase,
          verdict,
          escalated.map((f) => f.ruleId),
          0,
        ),
      );
    }
    out.push({
      id: evalCase.id,
      expected: evalCase.expect.verdict,
      rules,
      llm: arms,
    });
  }
  const downgrades = out.reduce(
    (n, c) =>
      n +
      c.llm.filter((a) => verdictRank(a.verdict) < verdictRank(c.rules)).length,
    0,
  );
  const fooled = Array.from(
    { length: repeats },
    (_, r) =>
      out.filter(
        (c) =>
          c.id.startsWith("rt-") &&
          c.llm[r]?.judgements.every((j) => j.verdict === "benign"),
      ).length,
  );
  return {
    cases: out,
    rules: computeMetrics(rulesResults),
    llm: llmResults.map(computeMetrics),
    calls,
    costUsd,
    downgrades,
    fooled,
  };
}

function renderAblation(report: AblationReport): string {
  const ratio = ({ hit, total }: { hit: number; total: number }) =>
    `${hit}/${total}`;
  const lines = [
    `croak LLM ablation — ${report.cases.length} install cases, Claude Haiku 5.5 on packages the rules only warned about`,
    "",
    `  ${"case".padEnd(34)} expected  rules   rules+LLM`,
    ...report.cases.map(
      (c) =>
        `  ${c.id.padEnd(34)} ${c.expected.padEnd(9)} ${c.rules.padEnd(7)} ${c.llm.map((a) => a.verdict).join(" ")}${c.llm.some((a) => a.errors > 0) ? "  (LLM errors)" : ""}`,
    ),
    "",
    `  block recall   rules ${ratio(report.rules.blockRecall)}   rules+LLM ${report.llm.map((m) => ratio(m.blockRecall)).join(" ")}`,
    `  false alarms   rules ${ratio(report.rules.falseAlarms)}   rules+LLM ${report.llm.map((m) => ratio(m.falseAlarms)).join(" ")}`,
    `  red team fooled the model: ${report.fooled.join(" ")} of ${report.cases.filter((c) => c.id.startsWith("rt-")).length}`,
    `  downgrades: ${report.downgrades} (escalate-only keeps this at 0)`,
    `  ${report.calls} calls · $${report.costUsd.toFixed(4)} total · $${(report.calls === 0 ? 0 : report.costUsd / report.calls).toFixed(5)} per call`,
  ];
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { repeats: { type: "string" }, json: { type: "boolean" } },
    strict: true,
  });
  if (
    process.env.ANTHROPIC_API_KEY === undefined ||
    process.env.ANTHROPIC_API_KEY === ""
  ) {
    process.stderr.write(
      "croak eval:llm needs ANTHROPIC_API_KEY (it calls Claude Haiku 5.5; costs cents)\n",
    );
    process.exit(2);
  }
  const client = new Anthropic();
  const report = await runAblation(
    loadCases(join(import.meta.dirname, "../../eval/cases")),
    (input) => triage(input, client),
    Number(values.repeats ?? "1"),
  );
  process.stdout.write(
    values.json === true
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderAblation(report),
  );
}

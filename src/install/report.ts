import {
  REPORT_SCHEMA,
  type RenderOptions,
  renderVerdict,
  safe,
} from "../repo-report.ts";
import { INCOMPLETE_ICON } from "../ui.ts";
import type { PlanOutcome } from "./scan.ts";

export function renderPlan(
  outcome: PlanOutcome,
  options: RenderOptions,
): string {
  const title = "croak plan";
  if (outcome.status === "incomplete") {
    const status = options.emoji
      ? `— ${INCOMPLETE_ICON} incomplete`
      : "- INCOMPLETE";
    return [
      options.emoji ? `🐸 ${title} ${status}` : `${title} ${status}`,
      "",
      `  could not finish: ${safe(outcome.reason)}`,
      "  An incomplete check is not a clean check.",
      "",
    ].join("\n");
  }
  return renderVerdict(
    {
      title,
      verdict: outcome.verdict,
      findings: outcome.findings,
      footer: `${outcome.added} new and ${outcome.changed} updated packages checked · ${Math.round(outcome.durationMs)} ms${outcome.llm === undefined ? "" : ` · ${outcome.llm.model}: ${outcome.llm.calls} call(s), $${outcome.llm.costUsd.toFixed(4)}`}`,
    },
    options,
  );
}

export function planToJson(outcome: PlanOutcome): string {
  return `${JSON.stringify({ schema: REPORT_SCHEMA, kind: "install-plan", ...outcome }, null, 2)}\n`;
}

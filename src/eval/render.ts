import { VERDICT_ICON } from "../ui.ts";
import type { Verdict } from "../verdict.ts";
import type { CaseResult, Metrics, Outcome, Ratio } from "./score.ts";

export interface Report {
  readonly results: readonly CaseResult[];
  readonly metrics: Metrics;
  readonly durationMs: number;
}

export interface RenderOptions {
  /** Emoji and bars for humans in a terminal; plain words for CI logs and pipes. */
  readonly emoji: boolean;
}

// Every icon is a single wide (2-column) emoji, and icons only sit in fixed
// columns after padded ASCII, so alignment holds without measuring widths.
const OUTCOME: Readonly<Record<Outcome, { icon: string; label: string }>> = {
  pass: { icon: "✅", label: "PASS" },
  missed: { icon: "❌", label: "MISSED" },
  under: { icon: "🔸", label: "UNDER" },
  "false-alarm": { icon: "📢", label: "FALSE ALARM" },
};

const BAR_WIDTH = 20;

function percent({ hit, total }: Ratio): string {
  return total === 0 ? "n/a" : `${Math.round((hit / total) * 100)}%`;
}

function bar({ hit, total }: Ratio): string {
  const filled = total === 0 ? 0 : Math.round((hit / total) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function verdict(value: Verdict, { emoji }: RenderOptions): string {
  return emoji ? `${VERDICT_ICON[value]} ${value.padEnd(5)}` : value.padEnd(5);
}

function caseLine(
  result: CaseResult,
  idWidth: number,
  options: RenderOptions,
): string {
  const { icon, label } = OUTCOME[result.outcome];
  const head = options.emoji ? icon : label.padEnd(11);
  const tail = [
    options.emoji && result.outcome !== "pass" ? label : "",
    result.missingRules.length > 0
      ? `missing: ${result.missingRules.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("  ");
  const line = `  ${head} ${result.id.padEnd(idWidth)}  expected ${verdict(result.expected, options)}  got ${verdict(result.got, options)}`;
  return tail ? `${line}  ${tail}` : line.trimEnd();
}

function metricLine(
  name: string,
  value: Ratio,
  options: RenderOptions,
): string {
  const numbers = `${`${value.hit}/${value.total}`.padStart(5)}  ${percent(value).padStart(4)}`;
  return `  ${name.padEnd(13)} ${numbers}${options.emoji ? `  ${bar(value)}` : ""}`;
}

export function renderReport(report: Report, options: RenderOptions): string {
  const { results, metrics } = report;
  const idWidth = Math.max(0, ...results.map((r) => r.id.length));
  const title = `croak eval — ${metrics.cases} cases (${metrics.malicious} malicious, ${metrics.benign} benign)`;

  return [
    options.emoji ? `🐸 ${title}` : title,
    "",
    ...results.map((result) => caseLine(result, idWidth, options)),
    "",
    metricLine("block recall", metrics.blockRecall, options),
    metricLine("flag recall", metrics.flagRecall, options),
    metricLine("false alarms", metrics.falseAlarms, options),
    metricLine("rule recall", metrics.ruleRecall, options),
    `  ${"time".padEnd(13)} ${Math.round(report.durationMs)} ms`,
    "",
  ].join("\n");
}

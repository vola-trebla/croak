import type { ScanOutcome } from "./scan.ts";
import { INCOMPLETE_ICON, SEVERITY_ICON, VERDICT_ICON } from "./ui.ts";
import type { Finding, Severity } from "./verdict.ts";

/** Bump when the JSON shape changes; agents and hooks depend on it. */
export const REPORT_SCHEMA = 1;

export interface RenderOptions {
  readonly emoji: boolean;
}

const ORDER: Readonly<Record<Severity, number>> = {
  block: 0,
  warn: 1,
  info: 2,
};
const MESSAGE_INDENT = " ".repeat(11);

function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      ORDER[a.severity] - ORDER[b.severity] || a.file.localeCompare(b.file),
  );
}

function findingLines(finding: Finding, { emoji }: RenderOptions): string[] {
  const label = emoji
    ? `${SEVERITY_ICON[finding.severity]} ${finding.severity.padEnd(5)}`
    : finding.severity.toUpperCase().padEnd(5);
  const where =
    finding.line === undefined
      ? finding.file
      : `${finding.file}:${finding.line}`;
  return [
    `  ${label}  ${where}  ${finding.ruleId}`,
    `${MESSAGE_INDENT}${finding.message}`,
  ];
}

export function renderScan(
  outcome: ScanOutcome,
  options: RenderOptions,
): string {
  const { emoji } = options;
  const title = `croak repo ${outcome.root}`;

  if (outcome.status === "incomplete") {
    const status = emoji ? `— ${INCOMPLETE_ICON} incomplete` : "- INCOMPLETE";
    return [
      emoji ? `🐸 ${title} ${status}` : `${title} ${status}`,
      "",
      `  could not finish: ${outcome.reason}`,
      "  An incomplete scan is not a clean scan.",
      "",
    ].join("\n");
  }

  const status = emoji
    ? `— ${VERDICT_ICON[outcome.verdict]} ${outcome.verdict}`
    : `- ${outcome.verdict.toUpperCase()}`;
  const body =
    outcome.findings.length === 0
      ? ["  nothing suspicious found"]
      : sortFindings(outcome.findings).flatMap((finding) =>
          findingLines(finding, options),
        );

  return [
    emoji ? `🐸 ${title} ${status}` : `${title} ${status}`,
    "",
    ...body,
    "",
    `  ${outcome.filesScanned} files scanned · ${Math.round(outcome.durationMs)} ms`,
    "",
  ].join("\n");
}

export function scanToJson(outcome: ScanOutcome): string {
  return `${JSON.stringify({ schema: REPORT_SCHEMA, ...outcome }, null, 2)}\n`;
}

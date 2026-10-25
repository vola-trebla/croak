import type { ScanOutcome } from "./scan.ts";
import { INCOMPLETE_ICON, SEVERITY_ICON, VERDICT_ICON } from "./ui.ts";
import type { Finding, Severity, Verdict } from "./verdict.ts";

/** Bump when the JSON shape changes; agents and hooks depend on it. */
export const REPORT_SCHEMA = 1;

export interface RenderOptions {
  readonly emoji: boolean;
}

/**
 * What each verdict means, said out loud: neither green nor yellow is a
 * promise that the repo is safe to run.
 */
const MEANING: Readonly<Record<Verdict, string>> = {
  allow:
    "Nothing suspicious found. Not a guarantee: croak only knows what it checks.",
  warn: "Needs your attention: croak found behavior worth reviewing before you install or run anything. This is not a safe verdict.",
  block:
    "Do not install or run this until you have reviewed the findings above.",
};

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

/**
 * Text from the scanned repo (commands, file names, hidden code) is hostile.
 * Escape C0/C1 control characters and bidi controls so it cannot move the
 * cursor, erase the 🔴 lines, or reorder the report itself (Trojan Source).
 */
function isUnsafe(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

export function safe(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += isUnsafe(code) ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

function findingLines(finding: Finding, { emoji }: RenderOptions): string[] {
  const label = emoji
    ? `${SEVERITY_ICON[finding.severity]} ${finding.severity.padEnd(5)}`
    : finding.severity.toUpperCase().padEnd(5);
  const file = safe(finding.file);
  const where = finding.line === undefined ? file : `${file}:${finding.line}`;
  return [
    `  ${label}  ${where}  ${finding.ruleId}`,
    `${MESSAGE_INDENT}${safe(finding.message)}`,
  ];
}

export function renderScan(
  outcome: ScanOutcome,
  options: RenderOptions,
): string {
  const { emoji } = options;
  const title = `croak repo ${safe(outcome.root)}`;

  if (outcome.status === "incomplete") {
    const status = emoji ? `— ${INCOMPLETE_ICON} incomplete` : "- INCOMPLETE";
    return [
      emoji ? `🐸 ${title} ${status}` : `${title} ${status}`,
      "",
      `  could not finish: ${safe(outcome.reason)}`,
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
    `  ${MEANING[outcome.verdict]}`,
    `  ${outcome.filesScanned} files scanned · ${Math.round(outcome.durationMs)} ms`,
    "",
  ].join("\n");
}

export function scanToJson(outcome: ScanOutcome): string {
  return `${JSON.stringify({ schema: REPORT_SCHEMA, ...outcome }, null, 2)}\n`;
}

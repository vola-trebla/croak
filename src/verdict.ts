export const VERDICTS = ["allow", "warn", "block"] as const;
export type Verdict = (typeof VERDICTS)[number];
/**
 * info  — something croak saw and reports for context (e.g. a known tool's
 *         postinstall); it never affects the verdict
 * warn  — code may run or could not be checked; a human should look
 * block — strong evidence of an attack
 */
export type Severity = "info" | "warn" | "block";

export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  /** Path relative to the scanned root, with forward slashes. */
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

const RANK: Readonly<Record<Verdict, number>> = { allow: 0, warn: 1, block: 2 };

export function verdictRank(verdict: Verdict): number {
  return RANK[verdict];
}

export function isVerdict(value: unknown): value is Verdict {
  return (
    typeof value === "string" && (VERDICTS as readonly string[]).includes(value)
  );
}

const SEVERITY_VERDICT: Readonly<Record<Severity, Verdict>> = {
  info: "allow",
  warn: "warn",
  block: "block",
};

/** The verdict is the most severe finding; info findings and no findings mean allow. */
export function aggregate(findings: readonly Finding[]): Verdict {
  return findings.reduce<Verdict>((worst, finding) => {
    const verdict = SEVERITY_VERDICT[finding.severity];
    return RANK[verdict] > RANK[worst] ? verdict : worst;
  }, "allow");
}

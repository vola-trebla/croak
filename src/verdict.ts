export const VERDICTS = ["allow", "warn", "block"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Severity = Exclude<Verdict, "allow">;

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

/** The verdict is the most severe finding; no findings means allow. */
export function aggregate(findings: readonly Finding[]): Verdict {
  return findings.reduce<Verdict>(
    (worst, finding) =>
      RANK[finding.severity] > RANK[worst] ? finding.severity : worst,
    "allow",
  );
}

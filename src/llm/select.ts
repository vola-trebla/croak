import { type Finding, type Verdict, verdictRank } from "../verdict.ts";

/** name@version at the start of a finding's file: "x@1.0.0/setup.js" → "x@1.0.0". */
const LABEL = /^((?:@[^/@]+\/)?[^/@][^/@]*@[^/]+)/;

export const labelOf = (file: string): string | undefined =>
  LABEL.exec(file)?.[1];

/**
 * Packages the rules warned about and did not block: the only ones the model
 * is asked about (D36). A block needs no second opinion; an allow is not
 * escalated, to keep the cost to the packages a human would look at anyway.
 */
export function warnedPackages(findings: readonly Finding[]): string[] {
  const worst = new Map<string, Verdict>();
  for (const f of findings) {
    const label = labelOf(f.file);
    if (label === undefined || f.severity === "info") continue;
    const v: Verdict = f.severity === "block" ? "block" : "warn";
    if (verdictRank(v) > verdictRank(worst.get(label) ?? "allow"))
      worst.set(label, v);
  }
  return [...worst].filter(([, v]) => v === "warn").map(([label]) => label);
}

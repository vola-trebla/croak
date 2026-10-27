import { describe, expect, it } from "vitest";
import { aggregate, type Finding, verdictRank } from "../verdict.ts";
import { escalate, type LlmJudgement } from "./escalate.ts";

const finding = (severity: Finding["severity"]): Finding => ({
  ruleId: "r",
  severity,
  file: "x@1",
  message: "m",
});
const judge = (verdict: LlmJudgement["verdict"]): LlmJudgement => ({
  label: "x@1",
  verdict,
  reason: "why",
  model: "m",
});

describe("escalate", () => {
  it("adds a block for malicious and a warning for suspicious", () => {
    expect(escalate([], [judge("malicious")])).toEqual([
      expect.objectContaining({ ruleId: "llm/triage", severity: "block" }),
    ]);
    expect(escalate([], [judge("suspicious")])[0]?.severity).toBe("warn");
  });

  it("adds nothing for benign: a package cannot talk its way to a lower verdict", () => {
    const findings = [finding("block")];
    expect(escalate(findings, [judge("benign")])).toEqual(findings);
  });

  it("never removes or changes a finding, and never lowers the verdict", () => {
    const severities: Finding["severity"][] = ["info", "warn", "block"];
    const verdicts: LlmJudgement["verdict"][] = [
      "benign",
      "suspicious",
      "malicious",
    ];
    for (const a of severities)
      for (const b of severities)
        for (const v of verdicts) {
          const findings = [finding(a), finding(b)];
          const out = escalate(findings, [judge(v)]);
          expect(out.slice(0, 2)).toEqual(findings);
          expect(verdictRank(aggregate(out))).toBeGreaterThanOrEqual(
            verdictRank(aggregate(findings)),
          );
        }
  });
});

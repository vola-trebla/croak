import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlmError } from "../llm/triage.ts";
import { loadCases } from "./case.ts";
import { runAblation, type TriageFn } from "./llm-ablation.ts";

const cases = loadCases(join(import.meta.dirname, "../../eval/cases"));
const answer =
  (verdict: "benign" | "suspicious" | "malicious"): TriageFn =>
  async (input) => ({
    judgement: { label: input.label, verdict, reason: "fake", model: "fake" },
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0.001,
  });

describe("runAblation (fake model, no network)", () => {
  it("asks the model only about packages the rules warned about, and never downgrades", async () => {
    const seen: string[] = [];
    const report = await runAblation(cases, async (input) => {
      seen.push(input.label);
      return answer("benign")(input);
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(report.downgrades).toBe(0);
    expect(report.llm[0]?.blockRecall).toEqual(report.rules.blockRecall);
    expect(report.fooled[0]).toBe(
      cases.filter((c) => c.id.startsWith("rt-")).length,
    );
  });

  it("raises every warned malicious case to a block when the model says malicious", async () => {
    const report = await runAblation(cases, answer("malicious"));
    expect(report.llm[0]?.blockRecall.hit).toBe(report.rules.blockRecall.total);
    expect(report.downgrades).toBe(0);
    expect(report.costUsd).toBeCloseTo(report.calls * 0.001);
  });

  it("gives the model a real diff against the previous version in red-team cases", async () => {
    let diff = "";
    await runAblation(
      cases.filter((c) => c.id === "rt-fake-answer"),
      async (input) => {
        diff = input.diff;
        return answer("benign")(input);
      },
    );
    expect(diff).toContain("=== setup.js (run at install, shown in full)");
    expect(diff).toContain('Buffer.from(b, "base64")');
  });

  it("keeps the rules verdict when the model fails", async () => {
    const report = await runAblation(
      cases.filter((c) => c.id.startsWith("rt-")),
      async () => {
        throw new LlmError("down");
      },
    );
    expect(
      report.cases.every(
        (c) => c.llm[0]?.verdict === c.rules && c.llm[0]?.errors === 1,
      ),
    ).toBe(true);
  });
});

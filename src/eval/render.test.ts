import { describe, expect, it } from "vitest";
import type { EvalCase } from "./case.ts";
import { type Report, renderReport } from "./render.ts";
import { computeMetrics, scoreCase } from "./score.ts";

const makeCase = (
  id: string,
  threat: EvalCase["threat"],
  verdict: EvalCase["expect"]["verdict"],
  rules: string[],
): EvalCase => ({
  id,
  kind: "repo",
  threat,
  description: id,
  expect: { verdict, rules },
  fixtureDir: "/fixture",
});

const results = [
  scoreCase(
    makeCase("d-postinstall", "D", "block", ["repo/lifecycle-script"]),
    "block",
    ["repo/lifecycle-script"],
    1,
  ),
  scoreCase(
    makeCase("d-vscode", "D", "block", ["repo/ide-autorun"]),
    "allow",
    [],
    1,
  ),
  scoreCase(makeCase("benign-app", "benign", "allow", []), "warn", [], 1),
];
const report: Report = {
  results,
  metrics: computeMetrics(results),
  durationMs: 12.4,
};

describe("renderReport", () => {
  it("plain mode has no emoji and greppable labels", () => {
    const text = renderReport(report, { emoji: false });
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).toContain("PASS        d-postinstall");
    expect(text).toContain("MISSED      d-vscode");
    expect(text).toContain("missing: repo/ide-autorun");
    expect(text).toContain("FALSE ALARM benign-app");
    expect(text).toContain("block recall    1/2   50%");
    expect(text).toContain("time          12 ms");
  });

  it("emoji mode shows icons, labels only for failures, and bars", () => {
    const text = renderReport(report, { emoji: true });
    expect(text).toMatch(/^🐸 croak eval — 3 cases \(2 malicious, 1 benign\)/);
    expect(text).toContain(
      "✅ d-postinstall  expected 🔴 block  got 🔴 block\n",
    );
    expect(text).toContain(
      "❌ d-vscode       expected 🔴 block  got 🟢 allow  MISSED",
    );
    expect(text).toContain(
      "📢 benign-app     expected 🟢 allow  got 🟡 warn   FALSE ALARM",
    );
    expect(text).toContain("██████████░░░░░░░░░░");
  });

  it("aligns case columns regardless of id length", () => {
    const lines = renderReport(report, { emoji: false })
      .split("\n")
      .filter((l) => l.includes("expected"));
    const columns = new Set(lines.map((l) => l.indexOf("expected")));
    expect(columns.size).toBe(1);
  });

  it("shows n/a instead of NaN for empty groups", () => {
    const empty: Report = {
      results: [],
      metrics: computeMetrics([]),
      durationMs: 0,
    };
    expect(renderReport(empty, { emoji: false })).toContain("0/0   n/a");
  });
});

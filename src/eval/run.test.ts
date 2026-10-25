import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RepoDetector } from "../detectors.ts";
import { loadCases } from "./case.ts";
import { runEval } from "./run.ts";

const CASES_DIR = join(import.meta.dirname, "../../eval/cases");

describe("runEval on the real case set", () => {
  const cases = loadCases(CASES_DIR);

  it("loads every case", () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
  });

  it("null baseline: nothing is flagged", () => {
    const { metrics } = runEval(cases, []);
    expect(metrics.blockRecall.hit).toBe(0);
    expect(metrics.flagRecall.hit).toBe(0);
  });

  it("a block-everything detector catches every threat", () => {
    const paranoid: RepoDetector = () => [
      { ruleId: "test/all", severity: "block", file: ".", message: "x" },
    ];
    const { metrics } = runEval(cases, [paranoid]);
    expect(metrics.blockRecall.hit).toBe(metrics.blockRecall.total);
  });
});

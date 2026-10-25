import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RepoDetector } from "../detectors/index.ts";
import { snapshotRepo } from "../repo-snapshot.ts";
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

describe("fixture hygiene", () => {
  // Both malicious and benign fixtures carry the marker, so a detector that keys
  // off it produces false alarms instead of a perfect score.
  const MARKERS = ["SYNTHETIC croak eval fixture", "croak-eval-synthetic"];

  it.each(loadCases(CASES_DIR).map((c) => [c.id, c.fixtureDir]))(
    "%s carries both markers",
    (_id, dir) => {
      const repo = snapshotRepo(dir);
      const text = repo.entries.map((e) => repo.read(e.path) ?? "").join("\n");
      for (const marker of MARKERS) expect(text).toContain(marker);
    },
  );
});

describe("regression guard", () => {
  const HISTORY_DIR = join(import.meta.dirname, "../../eval/history");

  /** Ids of every case that passed in any recorded eval snapshot. */
  function everPassed(): Set<string> {
    const ids = new Set<string>();
    for (const file of readdirSync(HISTORY_DIR).filter((f) =>
      f.endsWith(".json"),
    )) {
      const report: unknown = JSON.parse(
        readFileSync(join(HISTORY_DIR, file), "utf8"),
      );
      if (
        typeof report !== "object" ||
        report === null ||
        !("results" in report) ||
        !Array.isArray(report.results)
      ) {
        throw new Error(`${file}: not an eval report`);
      }
      for (const result of report.results as unknown[]) {
        if (
          typeof result === "object" &&
          result !== null &&
          "id" in result &&
          "outcome" in result
        ) {
          if (result.outcome === "pass" && typeof result.id === "string")
            ids.add(result.id);
        }
      }
    }
    return ids;
  }

  it("every case that ever passed still passes with the registered detectors", () => {
    const passed = everPassed();
    const regressed = runEval(loadCases(CASES_DIR))
      .results.filter((r) => passed.has(r.id) && r.outcome !== "pass")
      .map(
        (r) => `${r.id}: ${r.outcome} (expected ${r.expected}, got ${r.got})`,
      );
    expect(regressed).toEqual([]);
  });
});

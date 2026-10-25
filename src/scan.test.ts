import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScanTargetError, scanRepoAt } from "./scan.ts";

const CASES = join(import.meta.dirname, "../eval/cases");

describe("scanRepoAt", () => {
  it("returns findings and the verdict for a complete scan", () => {
    const outcome = scanRepoAt(join(CASES, "d-oversized-config/fixture"));
    expect(outcome).toMatchObject({ status: "complete", verdict: "warn" });
    if (outcome.status !== "complete") throw new Error("unreachable");
    expect(outcome.findings.map((f) => f.ruleId)).toEqual(["repo/unscanned"]);
    expect(outcome.filesScanned).toBeGreaterThan(0);
  });

  it("allows a clean repo", () => {
    expect(scanRepoAt(join(CASES, "benign-vite-app/fixture"))).toMatchObject({
      status: "complete",
      verdict: "allow",
      findings: [],
    });
  });

  it("reports an incomplete scan instead of a clean one when a limit is hit", () => {
    const root = mkdtempSync(join(tmpdir(), "croak-scan-"));
    try {
      for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.js`), "");
      expect(scanRepoAt(root, { limits: { maxEntries: 2 } })).toMatchObject({
        status: "incomplete",
        reason: expect.stringContaining("entries"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a target that is not a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "croak-scan-"));
    try {
      writeFileSync(join(root, "file.js"), "");
      mkdirSync(join(root, "dir"));
      expect(() => scanRepoAt(join(root, "file.js"))).toThrow(ScanTargetError);
      expect(() => scanRepoAt(join(root, "missing"))).toThrow(ScanTargetError);
      expect(scanRepoAt(join(root, "dir")).status).toBe("complete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

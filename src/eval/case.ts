import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isVerdict, type Verdict } from "../verdict.ts";

export const THREATS = ["A", "B", "C", "D", "E", "benign"] as const;
export type Threat = (typeof THREATS)[number];

export interface EvalCase {
  readonly id: string;
  readonly kind: "repo";
  readonly threat: Threat;
  readonly description: string;
  readonly expect: {
    readonly verdict: Verdict;
    /** Rule ids that must fire for this case. */
    readonly rules: readonly string[];
  };
  readonly fixtureDir: string;
}

export class CaseError extends Error {
  readonly caseId: string;

  constructor(caseId: string, message: string) {
    super(`${caseId}: ${message}`);
    this.name = "CaseError";
    this.caseId = caseId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreat(value: unknown): value is Threat {
  return (
    typeof value === "string" && (THREATS as readonly string[]).includes(value)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Validates a parsed case.json. Throws CaseError with a precise reason. */
export function parseCase(
  dirName: string,
  raw: unknown,
  fixtureDir: string,
): EvalCase {
  if (!isRecord(raw))
    throw new CaseError(dirName, "case.json must be a JSON object");
  const { id, kind, threat, description, expect } = raw;

  if (id !== dirName)
    throw new CaseError(dirName, `"id" must equal the directory name`);
  if (kind !== "repo") throw new CaseError(dirName, `"kind" must be "repo"`);
  if (!isThreat(threat))
    throw new CaseError(
      dirName,
      `"threat" must be one of ${THREATS.join(", ")}`,
    );
  if (typeof description !== "string" || description.trim() === "") {
    throw new CaseError(dirName, `"description" must be a non-empty string`);
  }
  if (!isRecord(expect))
    throw new CaseError(dirName, `"expect" must be an object`);
  if (!isVerdict(expect.verdict))
    throw new CaseError(
      dirName,
      `"expect.verdict" must be allow, warn, or block`,
    );
  if (!isStringArray(expect.rules))
    throw new CaseError(dirName, `"expect.rules" must be an array of strings`);

  // Guard against mislabeled cases: they would silently corrupt the metrics.
  if (threat === "benign" && expect.verdict === "block") {
    throw new CaseError(dirName, "a benign case cannot expect block");
  }
  if (threat !== "benign" && expect.verdict === "allow") {
    throw new CaseError(dirName, "a malicious case cannot expect allow");
  }

  return {
    id,
    kind,
    threat,
    description,
    expect: { verdict: expect.verdict, rules: expect.rules },
    fixtureDir,
  };
}

/** Loads every case under casesDir (one directory per case), sorted by id. */
export function loadCases(casesDir: string): EvalCase[] {
  const dirs = readdirSync(casesDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();

  return dirs.map((dirName) => {
    const caseDir = join(casesDir, dirName);
    const fixtureDir = join(caseDir, "fixture");
    // lstat: a symlinked fixture/ could point the eval at any directory.
    if (
      lstatSync(fixtureDir, { throwIfNoEntry: false })?.isDirectory() !== true
    ) {
      throw new CaseError(
        dirName,
        "missing fixture/ directory (or it is a symlink)",
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8"));
    } catch (error) {
      throw new CaseError(
        dirName,
        `cannot read case.json: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseCase(dirName, raw, fixtureDir);
  });
}

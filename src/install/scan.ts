import { performance } from "node:perf_hooks";
import { aggregate, type Finding, type Verdict } from "../verdict.ts";
import { type InstallDetector, installDetectors } from "./detectors.ts";
import { LockfileError, parseLockfile } from "./lockfile.ts";
import { diffLockfiles } from "./plan.ts";

export type PlanOutcome =
  | {
      readonly status: "complete";
      readonly verdict: Verdict;
      readonly findings: readonly Finding[];
      readonly added: number;
      readonly changed: number;
      readonly durationMs: number;
    }
  | {
      /** A lockfile could not be read. Never treat as clean. */
      readonly status: "incomplete";
      readonly reason: string;
      readonly durationMs: number;
    };

/**
 * Judges what an install would bring in, from the project's lockfile before
 * and the lockfile npm planned (`--package-lock-only --ignore-scripts`).
 * croak itself runs no package manager; it only reads the two files.
 */
export function planInstall(
  beforeText: string | undefined,
  afterText: string,
  detectors: readonly InstallDetector[] = installDetectors,
): PlanOutcome {
  const started = performance.now();
  const parse = (text: string, which: string) => {
    try {
      return parseLockfile(text);
    } catch (error) {
      if (error instanceof LockfileError)
        throw new LockfileError(`${which} lockfile: ${error.message}`);
      throw error;
    }
  };
  try {
    const before =
      beforeText === undefined ? undefined : parse(beforeText, "before");
    const changes = diffLockfiles(before, parse(afterText, "after"));
    const findings = detectors.flatMap((detect) => detect(changes));
    return {
      status: "complete",
      verdict: aggregate(findings),
      findings,
      added: changes.filter((c) => c.kind === "added").length,
      changed: changes.filter((c) => c.kind === "changed").length,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    if (!(error instanceof LockfileError)) throw error;
    return {
      status: "incomplete",
      reason: error.message,
      durationMs: performance.now() - started,
    };
  }
}

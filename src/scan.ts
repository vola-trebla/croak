import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  type RepoDetector,
  repoDetectors,
  scanRepo,
} from "./detectors/index.ts";
import {
  SnapshotIntegrityError,
  SnapshotLimitError,
  type SnapshotLimits,
  snapshotRepo,
} from "./repo-snapshot.ts";
import { aggregate, type Finding, type Verdict } from "./verdict.ts";

export type ScanOutcome =
  | {
      readonly status: "complete";
      readonly root: string;
      readonly verdict: Verdict;
      readonly findings: readonly Finding[];
      readonly filesScanned: number;
      readonly durationMs: number;
    }
  | {
      /** A limit or integrity check stopped the scan. Never treat as clean. */
      readonly status: "incomplete";
      readonly root: string;
      readonly reason: string;
      readonly durationMs: number;
    };

/** The scan target is missing or not a directory: a usage error, not a verdict. */
export class ScanTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanTargetError";
  }
}

export interface ScanOptions {
  readonly detectors?: readonly RepoDetector[];
  readonly limits?: Partial<SnapshotLimits>;
}

/**
 * Scans a repository directory. The root itself is chosen by the user and may
 * itself be a symbolic link, like /tmp on macOS; nothing inside it is followed.
 */
export function scanRepoAt(
  root: string,
  options: ScanOptions = {},
): ScanOutcome {
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new ScanTargetError(`${root} is not a directory`);
  }
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;
  try {
    const repo = snapshotRepo(root, options.limits);
    const findings = scanRepo(repo, options.detectors ?? repoDetectors);
    return {
      status: "complete",
      root,
      verdict: aggregate(findings),
      findings,
      filesScanned: repo.entries.filter((entry) => entry.kind === "file")
        .length,
      durationMs: elapsed(),
    };
  } catch (error) {
    if (
      error instanceof SnapshotLimitError ||
      error instanceof SnapshotIntegrityError
    ) {
      return {
        status: "incomplete",
        root,
        reason: error.message,
        durationMs: elapsed(),
      };
    }
    throw error;
  }
}

import type { RepoSnapshot } from "./repo-snapshot.ts";
import type { Finding } from "./verdict.ts";

export type RepoDetector = (repo: RepoSnapshot) => readonly Finding[];

/** Registered repo detectors. Empty in M1: the null baseline the eval starts from. */
export const repoDetectors: readonly RepoDetector[] = [];

export function scanRepo(
  repo: RepoSnapshot,
  detectors: readonly RepoDetector[] = repoDetectors,
): readonly Finding[] {
  return detectors.flatMap((detect) => detect(repo));
}

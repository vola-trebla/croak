import type { RepoSnapshot } from "../repo-snapshot.ts";
import type { Finding } from "../verdict.ts";
import { unscanned } from "./unscanned.ts";

export type RepoDetector = (repo: RepoSnapshot) => readonly Finding[];

/** Registered repo detectors. `unscanned` is the safety floor and always runs. */
export const repoDetectors: readonly RepoDetector[] = [unscanned];

export function scanRepo(
  repo: RepoSnapshot,
  detectors: readonly RepoDetector[] = repoDetectors,
): readonly Finding[] {
  return detectors.flatMap((detect) => detect(repo));
}

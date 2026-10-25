import type { RepoSnapshot } from "../repo-snapshot.ts";
import type { Finding } from "../verdict.ts";
import { hiddenCodeDetector } from "./hidden-code.ts";
import { ideAutorun } from "./ide-autorun.ts";
import { lifecycleScript } from "./lifecycle-script.ts";
import { nodeModulesPresent } from "./node-modules-present.ts";
import { obfuscation } from "./obfuscation.ts";
import { unscanned } from "./unscanned.ts";

export type RepoDetector = (repo: RepoSnapshot) => readonly Finding[];

/** Registered repo detectors. `unscanned` is the safety floor and always runs. */
export const repoDetectors: readonly RepoDetector[] = [
  unscanned,
  nodeModulesPresent,
  lifecycleScript,
  ideAutorun,
  hiddenCodeDetector,
  obfuscation,
];

export function scanRepo(
  repo: RepoSnapshot,
  detectors: readonly RepoDetector[] = repoDetectors,
): readonly Finding[] {
  return detectors.flatMap((detect) => detect(repo));
}

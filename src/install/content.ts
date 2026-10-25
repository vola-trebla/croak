import { hiddenCodeDetector } from "../detectors/hidden-code.ts";
import type { RepoDetector } from "../detectors/index.ts";
import { lifecycleScriptWith } from "../detectors/lifecycle-script.ts";
import { obfuscation } from "../detectors/obfuscation.ts";
import { unscanned } from "../detectors/unscanned.ts";
import type { RepoSnapshot } from "../repo-snapshot.ts";
import { isSuspiciousInDependency } from "../signals/code.ts";
import type { Finding } from "../verdict.ts";

/**
 * The repo detectors that make sense for a package's own files. Not
 * ide-autorun or git-config (they do nothing inside node_modules) and not
 * node-modules-present (bundled dependencies are normal in a tarball).
 */
const DEPENDENCY_DETECTORS: readonly RepoDetector[] = [
  unscanned,
  lifecycleScriptWith(isSuspiciousInDependency),
  hiddenCodeDetector,
  obfuscation,
];

/** Findings for one package's contents, with paths prefixed by `name@version/`. */
export function contentFindings(
  label: string,
  snapshot: RepoSnapshot,
): Finding[] {
  const findings: Finding[] = DEPENDENCY_DETECTORS.flatMap((detect) =>
    detect(snapshot),
  ).map((finding) => ({
    ...finding,
    file: `${label}/${finding.file}`,
  }));
  const natives = snapshot.entries.filter((e) => e.path.endsWith(".node"));
  const first = natives[0];
  if (first !== undefined) {
    findings.push({
      ruleId: "install/native-binary",
      severity: "warn",
      file: `${label}/${first.path}`,
      message: `ships ${natives.length} prebuilt native binar${natives.length === 1 ? "y" : "ies"} (.node) that croak cannot inspect`,
    });
  }
  return findings;
}

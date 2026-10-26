import type { RepoDetector } from "./index.ts";
import { isInNodeModules } from "./node-modules-present.ts";

/** Code that a JS toolchain, an IDE, or git may execute or load. */
const CODE = /\.(?:[cm]?[jt]sx?|json|sh|bash|zsh|py|rb|pl|ps1|gyp)$/;
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
/** Type declarations are never executed, and lib.dom.d.ts alone is over 1 MB. */
const DECLARATIONS = /\.d\.[cm]?ts$/;

export interface UnscannedPolicy {
  /**
   * JSON other than package.json is data: in a dependency nothing executes it
   * (loading it only parses it). In a repo, JSON configs can drive IDE tasks.
   */
  readonly jsonIsData: boolean;
  /** In a repo, node_modules is flagged on its own; in a package it is bundled code npm runs. */
  readonly downgradeInstalled: boolean;
}

/**
 * Safety floor: a code file too large to read was not scanned, so the repo is
 * not clean. Padding a config past the read limit must not hide a payload.
 */
export function unscannedWith({
  jsonIsData,
  downgradeInstalled,
}: UnscannedPolicy): RepoDetector {
  return (repo) =>
    repo.entries
      .filter((entry) => entry.kind === "oversized")
      .filter((entry) => {
        const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        return (
          entry.path.startsWith(".git/") ||
          /(?:^|\/)\.husky\//.test(entry.path) ||
          (CODE.test(name) && !LOCKFILES.has(name) && !DECLARATIONS.test(name))
        );
      })
      .map((entry) => {
        const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        const data =
          jsonIsData && name.endsWith(".json") && name !== "package.json";
        // Bundles over the limit are normal in installed dependencies; the
        // presence of node_modules itself is flagged by repo/node-modules-present.
        const installed = downgradeInstalled && isInNodeModules(entry.path);
        return {
          ruleId: "repo/unscanned",
          severity: installed || data ? "info" : "warn",
          file: entry.path,
          message: data
            ? `${entry.size} bytes exceeds the read limit; not scanned (JSON data, not executed)`
            : installed
              ? `${entry.size} bytes exceeds the read limit; not scanned (installed dependency)`
              : `${entry.size} bytes exceeds the read limit; not scanned`,
        };
      });
}

export const unscanned: RepoDetector = unscannedWith({
  jsonIsData: false,
  downgradeInstalled: true,
});

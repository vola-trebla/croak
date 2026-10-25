import type { RepoDetector } from "./index.ts";
import { isInNodeModules } from "./node-modules-present.ts";

/** Code that a JS toolchain, an IDE, or git may execute or load. */
const CODE = /\.(?:[cm]?[jt]sx?|json)$/;
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
/** Type declarations are never executed, and lib.dom.d.ts alone is over 1 MB. */
const DECLARATIONS = /\.d\.[cm]?ts$/;

/**
 * Safety floor: a code file too large to read was not scanned, so the repo is
 * not clean. Padding a config past the read limit must not hide a payload.
 */
export const unscanned: RepoDetector = (repo) =>
  repo.entries
    .filter((entry) => entry.kind === "oversized")
    .filter((entry) => {
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      return (
        entry.path.startsWith(".git/") ||
        (CODE.test(name) && !LOCKFILES.has(name) && !DECLARATIONS.test(name))
      );
    })
    .map((entry) => {
      // Bundles over 1 MB are normal in installed dependencies; the presence of
      // node_modules itself is flagged by repo/node-modules-present.
      const installed = isInNodeModules(entry.path);
      return {
        ruleId: "repo/unscanned",
        severity: installed ? "info" : "warn",
        file: entry.path,
        message: installed
          ? `${entry.size} bytes exceeds the read limit; not scanned (installed dependency)`
          : `${entry.size} bytes exceeds the read limit; not scanned`,
      };
    });

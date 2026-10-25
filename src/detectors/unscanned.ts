import type { RepoDetector } from "./index.ts";

/** Code that a JS toolchain, an IDE, or git may execute or load. */
const CODE = /\.(?:[cm]?[jt]sx?|json)$/;
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);

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
        (CODE.test(name) && !LOCKFILES.has(name))
      );
    })
    .map((entry) => ({
      ruleId: "repo/unscanned",
      severity: "warn",
      file: entry.path,
      message: `${entry.size} bytes exceeds the read limit; not scanned`,
    }));

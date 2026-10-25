import type { Finding } from "../verdict.ts";
import type { RepoDetector } from "./index.ts";

const SEGMENT = "node_modules";

/** The outermost node_modules directory containing path, or undefined. */
function nodeModulesRoot(path: string): string | undefined {
  const segments = path.split("/");
  const index = segments.indexOf(SEGMENT);
  return index === -1 ? undefined : segments.slice(0, index + 1).join("/");
}

export function isInNodeModules(path: string): boolean {
  return nodeModulesRoot(path) !== undefined;
}

/**
 * croak repo checks a repo before install, so installed dependencies in it are
 * a signal on their own: a committed node_modules is a classic hiding place.
 * One finding per directory instead of one per file keeps installed projects
 * readable.
 */
export const nodeModulesPresent: RepoDetector = (repo) => {
  const counts = new Map<string, number>();
  for (const { path } of repo.entries) {
    const root = nodeModulesRoot(path);
    if (root !== undefined) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([root, count]): Finding => ({
        ruleId: "repo/node-modules-present",
        severity: "warn",
        file: root,
        message: `node_modules present (${count} ${count === 1 ? "file" : "files"}): croak repo checks repos before install, so a fresh clone should not contain installed dependencies`,
      }),
    );
};

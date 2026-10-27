import { posix } from "node:path";
import { stripBom } from "../signals/text.ts";

/**
 * Where a package manager installs when it runs inside a workspace (D38): the
 * nearest directory, from `dir` up, with a package.json that has
 * `workspaces` (npm) or a pnpm-workspace.yaml (pnpm). The JSON is read as JSON
 * (M6 review): a key written with escapes is still the key npm reads.
 */

export interface WorkspaceFs {
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workspaceRoot(
  dir: string,
  manager: "npm" | "pnpm",
  fs: WorkspaceFs,
): string | undefined {
  for (let at = dir; ; at = posix.dirname(at)) {
    if (manager === "pnpm") {
      if (fs.exists(posix.join(at, "pnpm-workspace.yaml"))) return at;
    } else {
      const path = posix.join(at, "package.json");
      if (fs.exists(path)) {
        let manifest: unknown;
        try {
          manifest = JSON.parse(stripBom(fs.readFile(path)));
        } catch (error) {
          // npm fails on it too; it hides no install.
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (isRecord(manifest) && manifest.workspaces !== undefined) return at;
      }
    }
    if (at === "/") return undefined;
  }
}

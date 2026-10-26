import { posix } from "node:path";
import {
  INSTALL_SCRIPTS,
  lifecycleScriptWith,
} from "../detectors/lifecycle-script.ts";
import {
  MAX_FILE_BYTES,
  type RepoEntry,
  type RepoSnapshot,
} from "../repo-snapshot.ts";
import { isSuspicious } from "../signals/code.ts";
import { analyzeShell } from "../signals/shell.ts";
import { stripBom } from "../signals/text.ts";
import type { Finding } from "../verdict.ts";

/**
 * The project's own install scripts (whole-project review, D35). A plain
 * `npm install` and `npm ci` run the root package.json's preinstall, install,
 * postinstall and prepare (and node-gyp for a binding.gyp) — the fake
 * test-assignment attack. croak judges them with the repo rules, on a small
 * snapshot: the manifest, binding.gyp, and the local files its scripts run.
 * Not all of `croak repo`: a committed node_modules would make every install
 * in an existing project a warning.
 */

export interface ProjectFs {
  /** A regular file's text, or undefined. */
  readonly read: (path: string) => string | undefined;
  /** What is at a path, without following symlinks. */
  readonly kind: (
    path: string,
  ) => { kind: "file" | "symlink" | "other"; size: number } | undefined;
}

const policy = lifecycleScriptWith({
  suspicious: isSuspicious,
  scripts: INSTALL_SCRIPTS,
  manifests: "root",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectScriptFindings(dir: string, fs: ProjectFs): Finding[] {
  const manifest = fs.read(posix.join(dir, "package.json"));
  if (manifest === undefined) return [];
  let scripts: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(stripBom(manifest));
    if (isRecord(data) && isRecord(data.scripts)) scripts = data.scripts;
  } catch {
    // The detector reports an unreadable package.json itself.
  }
  // Every local file any script runs (install scripts call others via npm run).
  const files = new Set(["package.json", "binding.gyp"]);
  for (const command of Object.values(scripts))
    if (typeof command === "string")
      for (const file of analyzeShell(command).localFiles) {
        const path = posix.normalize(file);
        if (path !== ".." && !path.startsWith("../") && !path.startsWith("/"))
          files.add(path);
      }
  const entries: RepoEntry[] = [];
  const texts = new Map<string, string>();
  for (const path of files) {
    const at = fs.kind(posix.join(dir, path));
    if (at === undefined || at.kind === "other") continue;
    if (at.kind === "symlink") {
      entries.push({ path, kind: "symlink", size: 0 });
      continue;
    }
    const oversized = at.size > MAX_FILE_BYTES;
    entries.push({
      path,
      kind: oversized ? "oversized" : "file",
      size: at.size,
    });
    const text = oversized ? undefined : fs.read(posix.join(dir, path));
    if (text !== undefined) texts.set(path, text);
  }
  const snapshot: RepoSnapshot = { entries, read: (path) => texts.get(path) };
  return [...policy(snapshot)];
}

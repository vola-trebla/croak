import { posix } from "node:path";
import type { RepoSnapshot } from "../repo-snapshot.ts";
import { analyzeShell } from "../signals/shell.ts";
import { stripBom } from "../signals/text.ts";

/**
 * What the model sees (M5, D36): the added and changed lines between a
 * package's previous version and this one, most telling files first —
 * package.json, then the files its install scripts run, then other code —
 * within a character budget. Attacks add code, so removed lines are only
 * counted. A new package (no previous version) is shown as all added.
 */

/** Room for the most telling files; triage cuts anything longer. */
export const DIFF_BUDGET = 50_000;
/** Minified bundles are one huge line; each shown line is cut to this. */
const MAX_LINE = 400;
const CODE = /\.(?:[cm]?[jt]sx?|json|sh|bash|py|gyp)$/;
const SKIPPED =
  /\.(?:d\.[cm]?ts|map)$|(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/;
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Files the install scripts run, from the new version's package.json. */
function installFiles(after: RepoSnapshot): Set<string> {
  const files = new Set<string>();
  let manifest: unknown;
  try {
    manifest = JSON.parse(stripBom(after.read("package.json") ?? ""));
  } catch {
    return files;
  }
  const scripts =
    isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
  for (const name of INSTALL_SCRIPTS) {
    const command = scripts[name];
    if (typeof command === "string")
      for (const file of analyzeShell(command).localFiles)
        files.add(posix.normalize(file));
  }
  return files;
}

const cut = (line: string): string =>
  line.length > MAX_LINE
    ? `${line.slice(0, MAX_LINE)}… (${line.length} characters)`
    : line;

/** Lines of `after` that `before` does not have, with their line numbers. */
function addedLines(
  before: string | undefined,
  after: string,
): { lines: string[]; removed: number } {
  const old = new Map<string, number>();
  for (const line of (before ?? "").split("\n"))
    old.set(line, (old.get(line) ?? 0) + 1);
  const lines: string[] = [];
  after.split("\n").forEach((line, index) => {
    const left = old.get(line) ?? 0;
    if (left > 0) old.set(line, left - 1);
    else if (line.trim() !== "") lines.push(`+ ${index + 1}: ${cut(line)}`);
  });
  const removed = [...old.values()].reduce((sum, n) => sum + n, 0);
  return { lines, removed };
}

export function versionDiff(
  before: RepoSnapshot | undefined,
  after: RepoSnapshot,
  budget = DIFF_BUDGET,
): string {
  const install = installFiles(after);
  const rank = (path: string): number =>
    path === "package.json" ? 0 : install.has(path) ? 1 : 2;
  const paths = after.entries
    .filter(
      (e) =>
        (e.kind === "file" || e.kind === "oversized") &&
        CODE.test(e.path) &&
        !SKIPPED.test(e.path),
    )
    .map((e) => e.path)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const byPath = new Map(after.entries.map((e) => [e.path, e]));
  const sections: string[] = [];
  const notes: string[] = [];
  let used = 0;
  for (const path of paths) {
    const entry = byPath.get(path);
    if (entry?.kind === "oversized") {
      notes.push(`${path}: too large to show (${entry.size} bytes)`);
      continue;
    }
    const text = after.read(path) ?? "";
    const old = before?.read(path);
    if (old === text) continue;
    const { lines, removed } = addedLines(old, text);
    if (lines.length === 0 && removed === 0) continue;
    const head =
      old === undefined
        ? `=== ${path} (new file)`
        : `=== ${path} (changed: ${lines.length} line(s) added, ${removed} removed)`;
    const section = [head, ...lines].join("\n");
    if (used + section.length > budget) {
      // A file that does not fit still gets its header, so the model knows it exists.
      notes.push(`${head.slice(4)}: not shown, over the size budget`);
      continue;
    }
    sections.push(section);
    used += section.length + 1;
  }
  const removedFiles = (before?.entries ?? [])
    .filter(
      (e) => e.kind === "file" && CODE.test(e.path) && !byPath.has(e.path),
    )
    .map((e) => e.path);
  if (removedFiles.length > 0)
    notes.push(`removed files: ${removedFiles.slice(0, 20).join(", ")}`);
  const links = after.entries
    .filter((e) => e.kind === "symlink")
    .map((e) => e.path);
  if (links.length > 0)
    notes.push(`symlinks (not read): ${links.slice(0, 20).join(", ")}`);
  const body = sections.join("\n");
  return notes.length === 0 ? body : `${body}\n=== notes\n${notes.join("\n")}`;
}

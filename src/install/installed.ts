import { posix } from "node:path";
import { stripBom } from "../signals/text.ts";

/**
 * What is really installed in a project, as a lockfile: the entries of
 * node_modules/.package-lock.json whose folder holds a package.json with the
 * same name and version (M4 review, D34). npm ignores hidden-lockfile entries
 * whose folders are missing, so a committed or stale hidden lockfile must not
 * make croak treat the tree as installed and skip it.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nameFromPath = (path: string): string =>
  path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

/** The verified lockfile text, or undefined when nothing is installed. */
export function installedLockfile(
  project: string,
  read: (path: string) => string | undefined,
): string | undefined {
  const text = read(posix.join(project, "node_modules", ".package-lock.json"));
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    return undefined; // npm rebuilds an unreadable hidden lockfile from the tree
  }
  if (!isRecord(data) || !isRecord(data.packages)) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [path, entry] of Object.entries(data.packages)) {
    if (!isRecord(entry) || path === "" || !path.startsWith("node_modules/"))
      continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        stripBom(read(posix.join(project, path, "package.json")) ?? ""),
      );
    } catch {
      continue; // no folder, or no readable package.json: not installed
    }
    const name =
      typeof entry.name === "string" ? entry.name : nameFromPath(path);
    if (
      isRecord(manifest) &&
      manifest.name === name &&
      manifest.version === entry.version
    )
      kept[path] = entry;
  }
  return JSON.stringify({
    ...data,
    packages: { "": data.packages[""] ?? {}, ...kept },
  });
}

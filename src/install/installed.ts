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

/** "@scope/name" → "@scope+name", as pnpm names its virtual store folders. */
const storeName = (name: string): string => name.replace("/", "+");

/**
 * The same for pnpm (M6, D38): the entries of node_modules/.pnpm/lock.yaml
 * whose virtual-store folder (name@version, or name@version_peers…) holds a
 * package.json with that name and version, as an npm v3 lockfile so the plan
 * diff is shared. A folder croak cannot find (pnpm shortens very long names)
 * counts as not installed, so it is checked.
 */
export function installedPnpmLockfile(
  project: string,
  read: (path: string) => string | undefined,
  list: (dir: string) => readonly string[],
  parse: (text: string) => readonly LockEntryLike[],
): string | undefined {
  const text = read(posix.join(project, "node_modules", ".pnpm", "lock.yaml"));
  if (text === undefined) return undefined;
  let entries: readonly LockEntryLike[];
  try {
    entries = parse(text);
  } catch {
    return undefined; // an unreadable hidden lockfile means nothing counts as installed
  }
  const store = posix.join(project, "node_modules", ".pnpm");
  const folders = list(store);
  const packages: Record<string, unknown> = { "": {} };
  for (const entry of entries) {
    if (entry.link || entry.version === undefined) continue;
    const base = `${storeName(entry.name)}@${entry.version}`;
    const installed = folders
      .filter(
        (f) =>
          f === base || f.startsWith(`${base}_`) || f.startsWith(`${base}(`),
      )
      .some((folder) => {
        try {
          const manifest: unknown = JSON.parse(
            stripBom(
              read(
                posix.join(
                  store,
                  folder,
                  "node_modules",
                  entry.name,
                  "package.json",
                ),
              ) ?? "",
            ),
          );
          return (
            isRecord(manifest) &&
            manifest.name === entry.name &&
            manifest.version === entry.version
          );
        } catch {
          return false;
        }
      });
    if (installed)
      packages[entry.path] = {
        name: entry.name,
        version: entry.version,
        resolved: entry.resolved,
        integrity: entry.integrity,
      };
  }
  return JSON.stringify({ lockfileVersion: 3, packages });
}

/** The fields of a lockfile entry this check needs. */
export interface LockEntryLike {
  readonly path: string;
  readonly name: string;
  readonly version: string | undefined;
  readonly resolved: string | undefined;
  readonly integrity: string | undefined;
  readonly link: boolean;
}

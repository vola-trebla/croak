import type { LockEntry } from "./lockfile.ts";

export interface PlanChange {
  readonly kind: "added" | "changed";
  readonly entry: LockEntry;
  /** For a version change, the version the project had before. */
  readonly previousVersion?: string;
}

const key = (entry: LockEntry): string =>
  `${entry.name}@${entry.version ?? "?"}`;

/**
 * Every package version the install would bring that the project did not
 * have — direct and transitive, each name@version once. A changed version of
 * an existing package is reported with the previous version.
 */
export function diffLockfiles(
  before: readonly LockEntry[] | undefined,
  after: readonly LockEntry[],
): PlanChange[] {
  const had = new Set((before ?? []).map(key));
  const previous = new Map<string, string>();
  for (const entry of before ?? [])
    if (entry.version !== undefined) previous.set(entry.name, entry.version);

  const seen = new Set<string>();
  const changes: PlanChange[] = [];
  for (const entry of after) {
    const id = key(entry);
    if (had.has(id) || seen.has(id)) continue;
    seen.add(id);
    const old = previous.get(entry.name);
    changes.push(
      old === undefined
        ? { kind: "added", entry }
        : { kind: "changed", entry, previousVersion: old },
    );
  }
  return changes;
}

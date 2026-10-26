import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Finding, Severity } from "../verdict.ts";

/**
 * Remembers the content findings of a tarball by its sha512 integrity (D32).
 * npm verifies every download against that same hash, so what it installs is
 * byte for byte what croak already read. Registry facts (release age,
 * publisher) are never cached: they change while the tarball does not.
 * Entries are keyed by croak's own code too, so changed rules never reuse an
 * old verdict. A corrupt or unreadable entry is a miss, not an error.
 */
export interface ContentCache {
  get(integrity: string, label: string): Finding[] | undefined;
  set(integrity: string, label: string, findings: readonly Finding[]): void;
}

/** Only sha512 is strong enough to stand in for the tarball's content. */
const cacheable = (integrity: string | undefined): integrity is string =>
  integrity !== undefined &&
  /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity.trim());

const SEVERITIES: ReadonlySet<Severity> = new Set(["info", "warn", "block"]);

function isFinding(value: unknown): value is Finding {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.ruleId === "string" &&
    typeof f.file === "string" &&
    typeof f.message === "string" &&
    typeof f.severity === "string" &&
    SEVERITIES.has(f.severity as Severity) &&
    (f.line === undefined || typeof f.line === "number")
  );
}

/** Errors from the filesystem (not bugs): the cache degrades to a miss. */
const isFsError = (error: unknown): boolean =>
  error instanceof Error &&
  typeof (error as { code?: unknown }).code === "string";

export function fileContentCache(
  dir: string,
  fingerprint: string,
): ContentCache {
  const path = (integrity: string): string =>
    join(
      dir,
      `${createHash("sha256").update(`${fingerprint}\n${integrity.trim()}`).digest("hex")}.json`,
    );
  return {
    get(integrity, label) {
      if (!cacheable(integrity)) return undefined;
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(path(integrity), "utf8"));
      } catch (error) {
        if (error instanceof SyntaxError || isFsError(error)) return undefined;
        throw error;
      }
      if (typeof data !== "object" || data === null) return undefined;
      const entry = data as Record<string, unknown>;
      // The same tarball under another name or version is not reused.
      if (
        entry.label !== label ||
        !Array.isArray(entry.findings) ||
        !entry.findings.every(isFinding)
      )
        return undefined;
      return entry.findings;
    },
    set(integrity, label, findings) {
      if (!cacheable(integrity)) return;
      const file = path(integrity);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // Write then rename, so a concurrent reader never sees half a file.
        writeFileSync(tmp, JSON.stringify({ label, findings }), {
          mode: 0o600,
        });
        renameSync(tmp, file);
      } catch (error) {
        if (!isFsError(error)) throw error;
        try {
          rmSync(tmp, { force: true });
        } catch (cleanup) {
          // Best effort: a stray .tmp file is never read back.
          if (!isFsError(cleanup)) throw cleanup;
        }
      }
    },
  };
}

/** A hash of croak's own code (the src/ or dist/ tree this module runs from). */
export function codeFingerprint(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : 1),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.[jt]s$/.test(entry.name) &&
        !/\.test\.[jt]s$/.test(entry.name)
      ) {
        hash.update(`${full.slice(root.length)}\n`);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

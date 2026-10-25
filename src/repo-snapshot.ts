import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

export type EntryKind = "file" | "symlink" | "oversized";

export interface RepoEntry {
  /** Relative to the snapshot root, with forward slashes. */
  readonly path: string;
  readonly kind: EntryKind;
  readonly size: number;
}

export interface RepoSnapshot {
  readonly entries: readonly RepoEntry[];
  /** Text of a regular file listed in the snapshot; undefined for anything else. */
  read(path: string): string | undefined;
}

export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Lists a repository without following symlinks. Symlinks and oversized files
 * are recorded (detectors may flag them) but never read. node_modules is
 * scanned on purpose: a committed node_modules is a hiding place.
 */
export function snapshotRepo(root: string): RepoSnapshot {
  const entries: RepoEntry[] = [];

  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, dirent.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (dirent.isSymbolicLink()) {
        entries.push({ path, kind: "symlink", size: 0 });
      } else if (dirent.isDirectory()) {
        if (dirent.name !== ".git") walk(absolute);
      } else if (dirent.isFile()) {
        const { size } = lstatSync(absolute);
        entries.push({
          path,
          kind: size > MAX_FILE_BYTES ? "oversized" : "file",
          size,
        });
      }
    }
  };

  walk(root);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const readable = new Set(
    entries.filter((e) => e.kind === "file").map((e) => e.path),
  );

  return {
    entries,
    read(path) {
      if (!readable.has(path)) return undefined;
      // O_NOFOLLOW: refuse if the file was swapped for a symlink after listing.
      const fd = openSync(
        join(root, path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        return readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    },
  };
}

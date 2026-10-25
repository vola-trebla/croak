import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
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

export interface SnapshotLimits {
  /** Every directory entry seen — files, directories, symlinks, anything. */
  readonly maxEntries: number;
  /** Directory nesting; the walk is recursive, so this also bounds the stack. */
  readonly maxDepth: number;
}

export const DEFAULT_LIMITS: SnapshotLimits = {
  maxEntries: 100_000,
  maxDepth: 64,
};

/** The repo exceeds a safety limit. Callers fail closed: an incomplete scan is not a clean scan. */
export class SnapshotLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotLimitError";
  }
}

/** A file changed between listing and reading. Callers fail closed. */
export class SnapshotIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotIntegrityError";
  }
}

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** What git itself executes from inside a root .git directory. */
const GIT_EXECUTED_FILES = ["config"];
const GIT_HOOKS_DIR = "hooks";

/**
 * Lists a repository without following symlinks. Symlinks and oversized files
 * are recorded (detectors may flag them) but never read. node_modules and
 * nested .git directories are walked on purpose: both are hiding places. The
 * root .git contributes only what git executes (config, hooks), not its
 * object store.
 */
export function snapshotRepo(
  root: string,
  limits: Partial<SnapshotLimits> = {},
): RepoSnapshot {
  // O_NOFOLLOW is the read-time symlink guard; without it (Windows) we refuse
  // rather than silently lose the protection.
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("croak requires a POSIX platform (O_NOFOLLOW unavailable)");
  }
  const { maxEntries, maxDepth } = { ...DEFAULT_LIMITS, ...limits };
  const entries: RepoEntry[] = [];
  const identities = new Map<string, Identity>();
  let seen = 0;

  const toPath = (absolute: string): string =>
    relative(root, absolute).split(sep).join("/");

  const count = (): void => {
    seen += 1;
    if (seen > maxEntries) {
      throw new SnapshotLimitError(`more than ${maxEntries} entries`);
    }
  };

  const addFile = (absolute: string): void => {
    const stats = lstatSync(absolute, { bigint: true });
    const path = toPath(absolute);
    const size = Number(stats.size);
    if (size > MAX_FILE_BYTES) {
      entries.push({ path, kind: "oversized", size });
    } else {
      entries.push({ path, kind: "file", size });
      identities.set(path, { dev: stats.dev, ino: stats.ino });
    }
  };

  /** Streams one directory's entries instead of loading them all at once. */
  const eachEntry = (
    dir: string,
    visit: (name: string, kind: "file" | "dir" | "symlink" | "other") => void,
  ): void => {
    const handle = opendirSync(dir);
    try {
      for (
        let dirent = handle.readSync();
        dirent !== null;
        dirent = handle.readSync()
      ) {
        count();
        const kind = dirent.isSymbolicLink()
          ? "symlink"
          : dirent.isDirectory()
            ? "dir"
            : dirent.isFile()
              ? "file"
              : "other";
        visit(dirent.name, kind);
      }
    } finally {
      handle.closeSync();
    }
  };

  const walkGitMeta = (gitDir: string): void => {
    eachEntry(gitDir, (name, kind) => {
      const absolute = join(gitDir, name);
      if (kind === "symlink") {
        entries.push({ path: toPath(absolute), kind: "symlink", size: 0 });
      } else if (kind === "file" && GIT_EXECUTED_FILES.includes(name)) {
        addFile(absolute);
      } else if (kind === "dir" && name === GIT_HOOKS_DIR) {
        eachEntry(absolute, (hook, hookKind) => {
          const hookPath = join(absolute, hook);
          if (hookKind === "file") addFile(hookPath);
          else if (hookKind === "symlink") {
            entries.push({ path: toPath(hookPath), kind: "symlink", size: 0 });
          }
        });
      }
    });
  };

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      throw new SnapshotLimitError(`directory depth exceeds ${maxDepth}`);
    }
    eachEntry(dir, (name, kind) => {
      const absolute = join(dir, name);
      if (kind === "symlink") {
        entries.push({ path: toPath(absolute), kind: "symlink", size: 0 });
      } else if (kind === "dir") {
        if (name === ".git" && dir === root) walkGitMeta(absolute);
        else walk(absolute, depth + 1);
      } else if (kind === "file") {
        addFile(absolute);
      }
    });
  };

  walk(root, 0);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    entries,
    read(path) {
      const expected = identities.get(path);
      if (expected === undefined) return undefined;
      // O_NOFOLLOW refuses a final-component symlink; the inode check below
      // catches any other swap, including an intermediate directory.
      const fd = openSync(
        join(root, path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stats = fstatSync(fd, { bigint: true });
        if (
          !stats.isFile() ||
          stats.dev !== expected.dev ||
          stats.ino !== expected.ino
        ) {
          throw new SnapshotIntegrityError(
            `${path} changed after it was listed`,
          );
        }
        // Read at most one byte past the cap, so growth after listing is detected
        // instead of silently read.
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let length = 0;
        for (
          let n = readSync(fd, buffer, 0, buffer.length, 0);
          n > 0 && length < buffer.length;
          n = readSync(fd, buffer, length, buffer.length - length, length)
        ) {
          length += n;
        }
        if (length > MAX_FILE_BYTES) {
          throw new SnapshotIntegrityError(
            `${path} grew past the read limit after it was listed`,
          );
        }
        return buffer.toString("utf8", 0, length);
      } finally {
        closeSync(fd);
      }
    },
  };
}

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  SnapshotIntegrityError,
  SnapshotLimitError,
  snapshotRepo,
} from "./repo-snapshot.ts";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "croak-snap-"));
  outside = mkdtempSync(join(tmpdir(), "croak-outside-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("snapshotRepo", () => {
  it("lists nested files with forward-slash paths, sorted", () => {
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "src", "deep", "a.js"), "a");
    const snap = snapshotRepo(root);
    expect(snap.entries.map((e) => e.path)).toEqual([
      "package.json",
      "src/deep/a.js",
    ]);
    expect(snap.read("src/deep/a.js")).toBe("a");
  });

  it("scans node_modules on purpose", () => {
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "index.js"), "");
    expect(snapshotRepo(root).entries.map((e) => e.path)).toEqual([
      "node_modules/x/index.js",
    ]);
  });

  it("records what git executes from the root .git (config, hooks) and skips the object store", () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    mkdirSync(join(root, ".git", "objects", "ab"), { recursive: true });
    writeFileSync(
      join(root, ".git", "config"),
      "[core]\n\tfsmonitor = echo pwned\n",
    );
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
    writeFileSync(join(root, ".git", "objects", "ab", "cdef"), "blob");
    const snap = snapshotRepo(root);
    expect(snap.entries.map((e) => e.path)).toEqual([
      ".git/config",
      ".git/hooks/post-checkout",
    ]);
    expect(snap.read(".git/config")).toContain("fsmonitor");
  });

  it("walks nested .git directories like any other directory", () => {
    mkdirSync(join(root, "src", ".git"), { recursive: true });
    writeFileSync(join(root, "src", ".git", "payload.js"), "x");
    expect(snapshotRepo(root).entries.map((e) => e.path)).toEqual([
      "src/.git/payload.js",
    ]);
  });

  it("records symlinks but never follows or reads them", () => {
    writeFileSync(join(outside, "secret"), "do not read");
    symlinkSync(join(outside, "secret"), join(root, "link"));
    symlinkSync(outside, join(root, "linkdir"));
    const snap = snapshotRepo(root);
    expect(snap.entries).toEqual([
      { path: "link", kind: "symlink", size: 0 },
      { path: "linkdir", kind: "symlink", size: 0 },
    ]);
    expect(snap.read("link")).toBeUndefined();
  });

  it("does not read oversized files or paths outside the listing", () => {
    writeFileSync(join(root, "big.js"), "x".repeat(MAX_FILE_BYTES + 1));
    writeFileSync(join(outside, "secret"), "do not read");
    const snap = snapshotRepo(root);
    expect(snap.entries[0]?.kind).toBe("oversized");
    expect(snap.read("big.js")).toBeUndefined();
    expect(snap.read(`../${outside.split("/").pop()}/secret`)).toBeUndefined();
  });

  it("refuses repos with more entries than the limit", () => {
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, name), "");
    expect(() => snapshotRepo(root, { maxEntries: 2 })).toThrow(
      SnapshotLimitError,
    );
    expect(() => snapshotRepo(root, { maxEntries: 2 })).toThrow(/entries/);
  });

  it("refuses directory trees deeper than the limit instead of overflowing the stack", () => {
    let dir = root;
    for (let i = 0; i < 5; i++) {
      dir = join(dir, `d${i}`);
      mkdirSync(dir);
    }
    writeFileSync(join(dir, "deep.js"), "");
    expect(() => snapshotRepo(root, { maxDepth: 3 })).toThrow(/depth/);
    expect(snapshotRepo(root, { maxDepth: 10 }).entries).toHaveLength(1);
  });

  it("counts directories toward the entry limit", () => {
    for (let i = 0; i < 30; i++) mkdirSync(join(root, `empty${i}`));
    expect(() => snapshotRepo(root, { maxEntries: 10 })).toThrow(
      SnapshotLimitError,
    );
  });

  it("refuses to read a file replaced after it was listed", () => {
    writeFileSync(join(root, "a.js"), "original");
    const snap = snapshotRepo(root);
    writeFileSync(join(root, "swap.js"), "swapped");
    renameSync(join(root, "swap.js"), join(root, "a.js")); // new inode, same path
    expect(() => snap.read("a.js")).toThrow(SnapshotIntegrityError);
  });

  it("refuses to read a file that grew past the limit after it was listed", () => {
    writeFileSync(join(root, "a.js"), "small");
    const snap = snapshotRepo(root);
    appendFileSync(join(root, "a.js"), "x".repeat(MAX_FILE_BYTES));
    expect(() => snap.read("a.js")).toThrow(/read limit/);
  });
});

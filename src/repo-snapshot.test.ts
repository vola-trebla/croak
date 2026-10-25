import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, snapshotRepo } from "./repo-snapshot.ts";

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

  it("skips .git but scans node_modules", () => {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "");
    writeFileSync(join(root, "node_modules", "x", "index.js"), "");
    expect(snapshotRepo(root).entries.map((e) => e.path)).toEqual([
      "node_modules/x/index.js",
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
    expect(
      snap.read("../" + outside.split("/").pop() + "/secret"),
    ).toBeUndefined();
  });
});

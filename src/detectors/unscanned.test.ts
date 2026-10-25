import { describe, expect, it } from "vitest";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";
import { unscanned } from "./unscanned.ts";

const repo = (entries: RepoEntry[]): RepoSnapshot => ({
  entries,
  read: () => undefined,
});
const big = (path: string): RepoEntry => ({
  path,
  kind: "oversized",
  size: 2_000_000,
});

describe("repo/unscanned", () => {
  it.each([
    "tailwind.config.js",
    "src/a.ts",
    "x.mjs",
    "y.cjs",
    "z.tsx",
    "package.json",
    ".git/config",
    ".git/hooks/post-checkout",
  ])("warns about an oversized %s that croak could not read", (path) => {
    expect(unscanned(repo([big(path)]))).toEqual([
      {
        ruleId: "repo/unscanned",
        severity: "warn",
        file: path,
        message: expect.stringContaining("not scanned"),
      },
    ]);
  });

  it.each([
    "package-lock.json",
    "npm-shrinkwrap.json",
    "sub/package-lock.json",
    "assets/video.mp4",
    "pnpm-lock.yaml",
    "node_modules/typescript/lib/lib.dom.d.ts",
    "types/index.d.mts",
  ])("ignores an oversized %s (lockfile or non-code)", (path) => {
    expect(unscanned(repo([big(path)]))).toEqual([]);
  });

  it("ignores files that were read normally", () => {
    expect(unscanned(repo([{ path: "a.js", kind: "file", size: 10 }]))).toEqual(
      [],
    );
  });
});

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Finding } from "../verdict.ts";
import { codeFingerprint, fileContentCache } from "./content-cache.ts";

const sha512 = `sha512-${"A".repeat(86)}==`;
const finding: Finding = {
  ruleId: "repo/lifecycle-script",
  severity: "warn",
  file: "x@1.0.0/package.json",
  message: "m",
  line: 3,
};
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "croak-cache-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("fileContentCache", () => {
  it("returns what was stored for the same tarball, name and croak code", () => {
    const dir = temp();
    const cache = fileContentCache(dir, "code-1");
    expect(cache.get(sha512, "x@1.0.0")).toBeUndefined();
    cache.set(sha512, "x@1.0.0", [finding]);
    expect(cache.get(sha512, "x@1.0.0")).toEqual([finding]);
    expect(fileContentCache(dir, "code-1").get(sha512, "x@1.0.0")).toEqual([
      finding,
    ]);
  });

  it("misses when croak's code changed, or the label differs", () => {
    const dir = temp();
    fileContentCache(dir, "code-1").set(sha512, "x@1.0.0", [finding]);
    expect(
      fileContentCache(dir, "code-2").get(sha512, "x@1.0.0"),
    ).toBeUndefined();
    expect(
      fileContentCache(dir, "code-1").get(sha512, "y@1.0.0"),
    ).toBeUndefined();
  });

  it("keeps entries for one tarball under different labels apart", () => {
    const dir = temp();
    const cache = fileContentCache(dir, "c");
    const other = { ...finding, ruleId: "install/provenance" };
    cache.set(sha512, "x@1", [finding]);
    cache.set(sha512, "provenance x@1", [other]);
    expect(cache.get(sha512, "x@1")).toEqual([finding]);
    expect(cache.get(sha512, "provenance x@1")).toEqual([other]);
  });

  it("caches only sha512 integrity", () => {
    const dir = temp();
    const cache = fileContentCache(dir, "c");
    cache.set("sha1-abc", "x@1", [finding]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("treats a corrupt or tampered entry as a miss", () => {
    const dir = temp();
    const cache = fileContentCache(dir, "c");
    cache.set(sha512, "x@1", [finding]);
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file ?? ""), "{ not json");
    expect(cache.get(sha512, "x@1")).toBeUndefined();
    writeFileSync(
      join(dir, file ?? ""),
      JSON.stringify({ label: "x@1", findings: [{ severity: "fine" }] }),
    );
    expect(cache.get(sha512, "x@1")).toBeUndefined();
  });

  it("degrades to no cache when the directory cannot be written", () => {
    const blocker = join(temp(), "file");
    writeFileSync(blocker, "");
    const cache = fileContentCache(join(blocker, "sub"), "c");
    expect(() => cache.set(sha512, "x@1", [finding])).not.toThrow();
    expect(cache.get(sha512, "x@1")).toBeUndefined();
  });
});

describe("codeFingerprint", () => {
  it("changes when a source file changes, and ignores tests", () => {
    const dir = temp();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;");
    const first = codeFingerprint(dir);
    writeFileSync(join(dir, "a.test.ts"), "test");
    expect(codeFingerprint(dir)).toBe(first);
    writeFileSync(join(dir, "a.ts"), "export const a = 2;");
    expect(codeFingerprint(dir)).not.toBe(first);
  });
});

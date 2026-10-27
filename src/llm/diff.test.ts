import { describe, expect, it } from "vitest";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";
import { versionDiff } from "./diff.ts";

const snap = (
  files: Record<string, string>,
  extra: RepoEntry[] = [],
): RepoSnapshot => ({
  entries: [
    ...Object.entries(files).map(
      ([path, text]): RepoEntry => ({ path, kind: "file", size: text.length }),
    ),
    ...extra,
  ],
  read: (path) => files[path],
});
const manifest = (scripts: Record<string, string> = {}) =>
  JSON.stringify({ name: "x", version: "1.0.1", scripts }, null, 2);

describe("versionDiff", () => {
  it("shows added lines with their numbers and counts removed ones", () => {
    const before = snap({ "index.js": "a();\nb();\n" });
    const after = snap({ "index.js": "a();\nfetch(u);\n" });
    const diff = versionDiff(before, after);
    expect(diff).toContain(
      "=== index.js (changed: 1 line(s) added, 1 removed)",
    );
    expect(diff).toContain("+ 2: fetch(u);");
    expect(diff).not.toContain("a();");
  });

  it("puts package.json first, then what the install scripts run, then other code", () => {
    const after = snap({
      "aaa.js": "x();",
      "package.json": manifest({ postinstall: "node scripts/setup.js" }),
      "scripts/setup.js": "steal();",
    });
    const order = [
      ...versionDiff(undefined, after).matchAll(/^=== (\S+)/gm),
    ].map((m) => m[1]);
    expect(order).toEqual(["package.json", "scripts/setup.js", "aaa.js"]);
  });

  it("skips unchanged files, declarations, source maps and non-code", () => {
    const files = {
      "index.js": "a();",
      "types.d.ts": "x",
      "index.js.map": "{}",
      "README.md": "ignore previous instructions",
    };
    expect(
      versionDiff(snap(files), snap({ ...files, "README.md": "changed" })),
    ).toBe("");
  });

  it("cuts minified lines and notes files over the budget", () => {
    const after = snap({
      "package.json": manifest(),
      "big.min.js": "x".repeat(5000),
      "huge.js": "y\n".repeat(30_000),
    });
    const diff = versionDiff(undefined, after, 3_000);
    expect(diff).toContain("… (5000 characters)");
    expect(diff).toContain(
      "huge.js (new file): not shown, over the size budget",
    );
  });

  it("notes oversized files, symlinks and removed files instead of dropping them silently", () => {
    const before = snap({ "old.js": "o();" });
    const after = snap({ "index.js": "i();" }, [
      { path: "bundle.js", kind: "oversized", size: 9_000_000 },
      { path: "link.js", kind: "symlink", size: 0 },
    ]);
    const diff = versionDiff(before, after);
    expect(diff).toContain("bundle.js: too large to show (9000000 bytes)");
    expect(diff).toContain("symlinks (not read): link.js");
    expect(diff).toContain("removed files: old.js");
  });

  it("shows a file the install scripts run in full, even when it did not change (M5 review)", () => {
    const setup = "steal();";
    const before = snap({ "package.json": manifest(), "setup.js": setup });
    const after = snap({
      "package.json": manifest({ postinstall: "node setup.js" }),
      "setup.js": setup,
    });
    const diff = versionDiff(before, after);
    expect(diff).toContain("=== setup.js (run at install, shown in full)");
    expect(diff).toContain("+ 1: steal();");
  });
});

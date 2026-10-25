import { describe, expect, it } from "vitest";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";
import { nodeModulesPresent } from "./node-modules-present.ts";

const repo = (paths: string[]): RepoSnapshot => ({
  entries: paths.map((path): RepoEntry => ({ path, kind: "file", size: 1 })),
  read: () => undefined,
});

describe("repo/node-modules-present", () => {
  it("emits nothing for a repo without node_modules", () => {
    expect(
      nodeModulesPresent(repo(["package.json", "src/node_modules_helper.js"])),
    ).toEqual([]);
  });

  it("emits one warning per node_modules directory, with its file count", () => {
    const findings = nodeModulesPresent(
      repo([
        "node_modules/a/index.js",
        "node_modules/b/index.js",
        "packages/web/node_modules/c/index.js",
        "src/index.js",
      ]),
    );
    expect(findings).toEqual([
      {
        ruleId: "repo/node-modules-present",
        severity: "warn",
        file: "node_modules",
        message: expect.stringMatching(/2 files.*before install/),
      },
      expect.objectContaining({
        file: "packages/web/node_modules",
        message: expect.stringContaining("1 file"),
      }),
    ]);
  });

  it("counts a nested node_modules toward its outermost one", () => {
    const findings = nodeModulesPresent(
      repo(["node_modules/a/node_modules/b/index.js"]),
    );
    expect(findings.map((f) => f.file)).toEqual(["node_modules"]);
  });
});

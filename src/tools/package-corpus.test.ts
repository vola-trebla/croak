import { describe, expect, it } from "vitest";
import { lockfileFor } from "./package-corpus.ts";

const packument = {
  versions: {
    "1.0.0": {
      dist: {
        tarball: "https://registry.npmjs.org/p/-/p-1.0.0.tgz",
        integrity: "sha512-x",
      },
      scripts: { test: "vitest", postinstall: "node install.js" },
      os: ["darwin"],
      cpu: ["arm64"],
    },
    "2.0.0": { dist: {}, gypfile: true },
    "3.0.0": { dist: {}, scripts: { prepare: "tsc" } },
  },
};
const entry = (version: string) =>
  JSON.parse(lockfileFor(packument, "p", version)).packages["node_modules/p"];

describe("lockfileFor", () => {
  it("records what npm would: URL, integrity, install scripts, platform", () => {
    expect(entry("1.0.0")).toEqual({
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/p/-/p-1.0.0.tgz",
      integrity: "sha512-x",
      hasInstallScript: true,
      os: ["darwin"],
      cpu: ["arm64"],
    });
  });

  it("counts a native build as an install script, but not prepare", () => {
    expect(entry("2.0.0").hasInstallScript).toBe(true);
    expect(entry("3.0.0").hasInstallScript).toBeUndefined();
  });

  it("refuses a version the registry does not list", () => {
    expect(() => lockfileFor(packument, "p", "9.9.9")).toThrow(
      /not on the registry/,
    );
  });
});

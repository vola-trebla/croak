import { describe, expect, it } from "vitest";
import type { LockEntry } from "./lockfile.ts";
import { metadataFindings, nearPopularName } from "./metadata.ts";
import type { PlanChange } from "./plan.ts";
import type { VersionFacts } from "./registry.ts";

const entry = (name: string, extra: Partial<LockEntry> = {}): LockEntry => ({
  path: `node_modules/${name}`,
  name,
  version: "2.0.0",
  resolved: `https://registry.npmjs.org/${name}/-/${name}-2.0.0.tgz`,
  integrity: "sha512-x",
  hasInstallScript: false,
  link: false,
  dev: false,
  optional: false,
  ...extra,
});
const change = (name: string, extra: Partial<LockEntry> = {}): PlanChange => ({
  kind: "added",
  entry: entry(name, extra),
});
const facts = (extra: Partial<VersionFacts> = {}): VersionFacts => ({
  created: new Date("2020-01-01"),
  published: new Date("2026-01-01"),
  ageDays: 300,
  hasProvenance: false,
  publisher: "alice",
  earlier: [{ version: "1.0.0", hasProvenance: false, publisher: "alice" }],
  ...extra,
});
const rules = (findings: ReturnType<typeof metadataFindings>) =>
  findings.map((f) => `${f.severity}:${f.ruleId}`);

describe("nearPopularName", () => {
  it.each([
    ["lodahs", "lodash"],
    ["expresss", "express"],
    ["react_dom", "react-dom"],
    ["axois", "axios"],
  ])("%s looks like %s", (name, popular) => {
    expect(nearPopularName(name)).toBe(popular);
  });

  it.each([
    "lodash",
    "react-dom",
    "@types/lodash",
    "vue-demi",
    "ws",
    "q",
    "my-own-tool",
  ])("%s is not a typo-squat", (name) => {
    expect(nearPopularName(name)).toBeUndefined();
  });
});

describe("metadataFindings", () => {
  it("is quiet for an old, ordinary version", () => {
    expect(metadataFindings(change("left-pad"), facts())).toEqual([]);
  });

  it("only warns on a recent release, never blocks on age alone (D25)", () => {
    expect(
      rules(
        metadataFindings(
          change("left-pad", { hasInstallScript: true }),
          facts({ ageDays: 1 }),
        ),
      ),
    ).toEqual(["warn:install/recent-release"]);
  });

  it("warns on dropped provenance, but not on provenance that never existed", () => {
    const dropped = facts({
      earlier: [{ version: "1.0.0", hasProvenance: true, publisher: "alice" }],
    });
    expect(rules(metadataFindings(change("lib"), dropped))).toEqual([
      "warn:install/provenance",
    ]);
    expect(rules(metadataFindings(change("lib"), facts()))).toEqual([]);
  });

  it("warns on a new publisher", () => {
    expect(
      rules(metadataFindings(change("lib"), facts({ publisher: "mallory" }))),
    ).toEqual(["warn:install/publisher"]);
  });

  it("blocks the hijacked-account pattern: install script plus dropped provenance or a new publisher", () => {
    const hijack = facts({
      publisher: "mallory",
      earlier: [{ version: "1.0.0", hasProvenance: true, publisher: "alice" }],
    });
    const findings = metadataFindings(
      change("lib", { hasInstallScript: true }),
      hijack,
    );
    expect(rules(findings)).toEqual([
      "block:install/provenance",
      "block:install/publisher",
    ]);
    expect(findings[0]?.message).toContain("hijacked");
  });

  it("warns on a typo-squat name, and blocks it when the package is brand new", () => {
    expect(rules(metadataFindings(change("lodahs"), facts()))).toEqual([
      "warn:install/name",
    ]);
    expect(
      rules(
        metadataFindings(
          change("lodahs"),
          facts({ created: new Date(Date.now() - 3 * 86_400_000) }),
        ),
      ),
    ).toEqual(["block:install/name", "warn:install/new-package"]);
  });

  it("warns on a brand-new package on its own", () => {
    expect(
      rules(
        metadataFindings(
          change("my-new-tool"),
          facts({ created: new Date(Date.now() - 86_400_000) }),
        ),
      ),
    ).toEqual(["warn:install/new-package"]);
  });

  it("warns when the registry does not list the package or the version", () => {
    expect(rules(metadataFindings(change("ghost"), "not-found"))).toEqual([
      "warn:install/registry",
    ]);
    expect(rules(metadataFindings(change("lib"), undefined))).toEqual([
      "warn:install/registry",
    ]);
  });
});

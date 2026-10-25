import { describe, expect, it } from "vitest";
import type { LockEntry } from "./lockfile.ts";
import {
  addedDependencyFindings,
  metadataFindings,
  nearPopularName,
} from "./metadata.ts";
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
  os: [],
  cpu: [],
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
  installScripts: [],
  dependencies: [],
  earlier: [
    {
      version: "1.0.0",
      hasProvenance: false,
      publisher: "alice",
      installScripts: [],
      dependencies: [],
    },
  ],
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
      earlier: [
        {
          version: "1.0.0",
          hasProvenance: true,
          publisher: "alice",
          installScripts: [],
          dependencies: [],
        },
      ],
    });
    expect(rules(metadataFindings(change("lib"), dropped))).toEqual([
      "warn:install/provenance",
    ]);
    expect(rules(metadataFindings(change("lib"), facts()))).toEqual([]);
  });

  it("only notes a new publisher on its own", () => {
    expect(
      rules(metadataFindings(change("lib"), facts({ publisher: "mallory" }))),
    ).toEqual(["info:install/publisher"]);
  });

  it("ignores a new publisher name on a version with provenance (a CI identity)", () => {
    expect(
      rules(
        metadataFindings(
          change("lib", { hasInstallScript: true }),
          facts({ publisher: "GitHub Actions", hasProvenance: true }),
        ),
      ),
    ).toEqual([]);
  });

  it("blocks the hijacked-account pattern: install script plus dropped provenance or a new publisher", () => {
    const hijack = facts({
      publisher: "mallory",
      earlier: [
        {
          version: "1.0.0",
          hasProvenance: true,
          publisher: "alice",
          installScripts: [],
          dependencies: [],
        },
      ],
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

describe("version-to-version changes", () => {
  const now = new Date("2026-10-25T00:00:00Z");

  it("warns on an install script the previous version did not have", () => {
    expect(
      rules(
        metadataFindings(
          change("lib"),
          facts({ installScripts: ["postinstall"] }),
          now,
        ),
      ),
    ).toEqual(["warn:install/new-install-script"]);
  });

  it("blocks a new install script in a release that also shows a registry warning", () => {
    expect(
      rules(
        metadataFindings(
          change("lib"),
          facts({ installScripts: ["postinstall"], ageDays: 1 }),
          now,
        ),
      ),
    ).toEqual([
      "warn:install/recent-release",
      "block:install/new-install-script",
    ]);
  });

  it("notes a new dependency and blocks a brand-new one (the axios pattern)", () => {
    const axios = facts({
      dependencies: ["follow-redirects", "plain-crypto-js"],
      earlier: [
        {
          version: "1.14.0",
          hasProvenance: true,
          publisher: "x",
          installScripts: [],
          dependencies: ["follow-redirects"],
        },
      ],
    });
    const created = new Map([
      ["plain-crypto-js", new Date("2026-10-23T00:00:00Z")],
    ]);
    const findings = addedDependencyFindings(
      change("axios"),
      axios,
      created,
      now,
    );
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "install/new-dependency",
        severity: "block",
        message: expect.stringContaining(
          "plain-crypto-js, a package created 2 day(s) ago",
        ),
      }),
    ]);
    const old = new Map([
      ["plain-crypto-js", new Date("2020-01-01T00:00:00Z")],
    ]);
    expect(
      addedDependencyFindings(change("axios"), axios, old, now)[0]?.severity,
    ).toBe("info");
  });
});

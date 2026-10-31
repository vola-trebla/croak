import { describe, expect, it } from "vitest";
import type { BuildIdentity } from "../crypto/der.ts";
import type { ProvenanceCheck } from "../crypto/sigstore.ts";
import type { PlanChange } from "./plan.ts";
import {
  type Provenance,
  provenanceBaseline,
  provenanceFindings,
} from "./provenance.ts";
import type { EarlierVersion, VersionFacts } from "./registry.ts";

const change: PlanChange = {
  kind: "changed",
  entry: {
    path: "node_modules/p",
    name: "p",
    version: "2.0.0",
    resolved: "https://registry.npmjs.org/p/-/p-2.0.0.tgz",
    integrity: "sha512-x",
    hasInstallScript: false,
    link: false,
    dev: false,
    optional: false,
    os: [],
    cpu: [],
  },
};

const identity = (extra: Partial<BuildIdentity> = {}): BuildIdentity => ({
  issuer: "https://token.actions.githubusercontent.com",
  buildSignerUri:
    "https://github.com/acme/p/.github/workflows/release.yml@refs/tags/v2.0.0",
  runnerEnvironment: "github-hosted",
  sourceRepositoryUri: "https://github.com/acme/p",
  sourceRepositoryDigest: "abc",
  sourceRepositoryRef: "refs/tags/v2.0.0",
  sourceRepositoryId: "42",
  buildConfigUri:
    "https://github.com/acme/p/.github/workflows/release.yml@refs/tags/v2.0.0",
  ...extra,
});
const verified = (extra: Partial<BuildIdentity> = {}): ProvenanceCheck => ({
  status: "verified",
  identity: identity(extra),
  loggedAt: new Date("2026-01-01"),
});
const previousIdentity = verified({
  sourceRepositoryRef: "refs/tags/v1.0.0",
  buildConfigUri:
    "https://github.com/acme/p/.github/workflows/release.yml@refs/tags/v1.0.0",
});
const noScript = { current: "", previous: "" };
const newScript = { current: "postinstall: node x.js", previous: "" };

/** The planned version against a 1.0.0 baseline, with these install scripts. */
const findings = (
  current: Provenance,
  previous: Provenance | undefined,
  scripts: { current: string; previous: string },
) =>
  provenanceFindings(
    change,
    current,
    previous === undefined
      ? undefined
      : {
          version: "1.0.0",
          provenance: previous,
          installCommands: scripts.previous,
        },
    scripts.current,
  );
const summary = (found: ReturnType<typeof provenanceFindings>) =>
  found.map((f) => `${f.severity}:${f.ruleId}`);

describe("provenanceFindings", () => {
  it("is silent when the same repo and workflow built both versions", () => {
    expect(findings(verified(), previousIdentity, noScript)).toEqual([]);
  });

  it("is silent for a renamed repo: the numeric id is the same", () => {
    const renamed = verified({
      sourceRepositoryUri: "https://github.com/acme-org/p",
      buildConfigUri:
        "https://github.com/acme-org/p/.github/workflows/release.yml@refs/tags/v2.0.0",
    });
    expect(findings(renamed, previousIdentity, noScript)).toEqual([]);
  });

  it("blocks a provenance claim that does not verify", () => {
    const found = findings(
      { status: "invalid", reason: "the envelope's signature does not verify" },
      previousIdentity,
      noScript,
    );
    expect(found).toEqual([
      expect.objectContaining({
        ruleId: "install/provenance",
        severity: "block",
        file: "p@2.0.0",
        message: expect.stringContaining("envelope's signature"),
      }),
    ]);
  });

  it.each<[string, Provenance]>([
    ["unverifiable", { status: "unverifiable", reason: "a newer croak may" }],
    ["missing", "missing"],
  ])("warns when the provenance is %s", (_what, current) => {
    expect(summary(findings(current, previousIdentity, noScript))).toEqual([
      "warn:install/provenance",
    ]);
  });

  it("warns when another repository built it", () => {
    const other = verified({
      sourceRepositoryUri: "https://github.com/mallory/p",
      sourceRepositoryId: "666",
    });
    const found = findings(other, previousIdentity, noScript);
    expect(found).toEqual([
      expect.objectContaining({
        severity: "warn",
        message: expect.stringMatching(
          /mallory\/p.*acme\/p, which built 1\.0\.0/,
        ),
      }),
    ]);
  });

  it("tells the same id at another issuer apart (a GitLab project is not a GitHub repo)", () => {
    const gitlab = verified({
      issuer: "https://gitlab.com",
      sourceRepositoryUri: "https://gitlab.com/acme/p",
      buildConfigUri:
        "https://gitlab.com/acme/p/.github/workflows/release.yml@refs/tags/v2.0.0",
    });
    expect(findings(gitlab, previousIdentity, noScript)).toEqual([
      expect.objectContaining({
        severity: "warn",
        message: expect.stringContaining(
          "was built from https://gitlab.com/acme/p",
        ),
      }),
    ]);
  });

  it("compares repository URLs when the ids are missing", () => {
    const old = verified({ sourceRepositoryId: undefined });
    const other = verified({
      sourceRepositoryId: undefined,
      sourceRepositoryUri: "https://github.com/mallory/p",
    });
    expect(summary(findings(other, old, noScript))).toEqual([
      "warn:install/provenance",
    ]);
  });

  it("warns when another workflow built it, ignoring the ref", () => {
    const other = verified({
      buildConfigUri:
        "https://github.com/acme/p/.github/workflows/publish-now.yml@refs/heads/main",
    });
    expect(findings(other, previousIdentity, noScript)).toEqual([
      expect.objectContaining({
        severity: "warn",
        message: expect.stringContaining("publish-now.yml"),
      }),
    ]);
  });

  it("blocks a changed build with a new or changed install script", () => {
    const other = verified({ sourceRepositoryId: "666" });
    expect(summary(findings(other, previousIdentity, newScript))).toEqual([
      "block:install/provenance",
    ]);
    const changedScript = {
      current: "postinstall: b",
      previous: "postinstall: a",
    };
    expect(summary(findings(other, previousIdentity, changedScript))).toEqual([
      "block:install/provenance",
    ]);
  });

  it("does not block a changed build that runs the same install script", () => {
    const other = verified({ sourceRepositoryId: "666" });
    const same = {
      current: "install: node-gyp rebuild",
      previous: "install: node-gyp rebuild",
    };
    expect(summary(findings(other, previousIdentity, same))).toEqual([
      "warn:install/provenance",
    ]);
  });

  it.each<[string, Provenance | undefined]>([
    ["no previous version", undefined],
    ["a previous version without provenance", "missing"],
    [
      "a previous version that does not verify",
      { status: "invalid", reason: "x" },
    ],
  ])("compares nothing with %s", (_what, previous) => {
    const other = verified({ sourceRepositoryId: "666" });
    expect(findings(other, previous, newScript)).toEqual([]);
  });
});

describe("provenanceBaseline", () => {
  const version = (v: string, hasProvenance: boolean): EarlierVersion => ({
    version: v,
    hasProvenance,
    publisher: "ana",
    installScripts: [],
    installCommands: "",
    dependencies: [],
  });
  const facts = (
    previous: EarlierVersion | undefined,
    earlier: EarlierVersion[],
  ) => ({ previous, earlier }) as unknown as VersionFacts;

  it("is the predecessor when it has provenance", () => {
    const prev = version("1.9.0", true);
    expect(provenanceBaseline(facts(prev, [prev]))?.version).toBe("1.9.0");
  });

  it("skips a predecessor without provenance for the newest settled version with it", () => {
    const gap = version("1.9.0", false);
    expect(
      provenanceBaseline(
        facts(gap, [gap, version("1.8.0", true), version("1.7.0", true)]),
      )?.version,
    ).toBe("1.8.0");
  });

  it("is undefined when no settled version has provenance", () => {
    const gap = version("1.9.0", false);
    expect(provenanceBaseline(facts(gap, [gap]))).toBeUndefined();
    expect(provenanceBaseline(facts(undefined, []))).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import type { BuildIdentity } from "../crypto/der.ts";
import type { ProvenanceCheck } from "../crypto/sigstore.ts";
import type { PlanChange } from "./plan.ts";
import { provenanceFindings } from "./provenance.ts";

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

const summary = (findings: ReturnType<typeof provenanceFindings>) =>
  findings.map((f) => `${f.severity}:${f.ruleId}`);

describe("provenanceFindings", () => {
  it("is silent when the same repo and workflow built both versions", () => {
    expect(
      provenanceFindings(change, verified(), previousIdentity, noScript),
    ).toEqual([]);
  });

  it("is silent for a renamed repo: the numeric id is the same", () => {
    const renamed = verified({
      sourceRepositoryUri: "https://github.com/acme-org/p",
      buildConfigUri:
        "https://github.com/acme-org/p/.github/workflows/release.yml@refs/tags/v2.0.0",
    });
    expect(
      provenanceFindings(change, renamed, previousIdentity, noScript),
    ).toEqual([]);
  });

  it("blocks a provenance claim that does not verify", () => {
    const findings = provenanceFindings(
      change,
      { status: "invalid", reason: "the envelope's signature does not verify" },
      previousIdentity,
      noScript,
    );
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "install/provenance",
        severity: "block",
        file: "p@2.0.0",
        message: expect.stringContaining("envelope's signature"),
      }),
    ]);
  });

  it.each<[string, ProvenanceCheck | "missing"]>([
    ["unverifiable", { status: "unverifiable", reason: "a newer croak may" }],
    ["missing", "missing"],
  ])("warns when the provenance is %s", (_what, current) => {
    expect(
      summary(provenanceFindings(change, current, previousIdentity, noScript)),
    ).toEqual(["warn:install/provenance"]);
  });

  it("warns when another repository built it", () => {
    const other = verified({
      sourceRepositoryUri: "https://github.com/mallory/p",
      sourceRepositoryId: "666",
    });
    const findings = provenanceFindings(
      change,
      other,
      previousIdentity,
      noScript,
    );
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warn",
        message: expect.stringMatching(/mallory\/p.*acme\/p/),
      }),
    ]);
  });

  it("compares repository URLs when the ids are missing", () => {
    const old = verified({ sourceRepositoryId: undefined });
    const other = verified({
      sourceRepositoryId: undefined,
      sourceRepositoryUri: "https://github.com/mallory/p",
    });
    expect(summary(provenanceFindings(change, other, old, noScript))).toEqual([
      "warn:install/provenance",
    ]);
  });

  it("warns when another workflow built it, ignoring the ref", () => {
    const other = verified({
      buildConfigUri:
        "https://github.com/acme/p/.github/workflows/publish-now.yml@refs/heads/main",
    });
    expect(
      provenanceFindings(change, other, previousIdentity, noScript),
    ).toEqual([
      expect.objectContaining({
        severity: "warn",
        message: expect.stringContaining("publish-now.yml"),
      }),
    ]);
  });

  it("blocks a changed build with a new or changed install script", () => {
    const other = verified({ sourceRepositoryId: "666" });
    expect(
      summary(provenanceFindings(change, other, previousIdentity, newScript)),
    ).toEqual(["block:install/provenance"]);
    const changedScript = {
      current: "postinstall: b",
      previous: "postinstall: a",
    };
    expect(
      summary(
        provenanceFindings(change, other, previousIdentity, changedScript),
      ),
    ).toEqual(["block:install/provenance"]);
  });

  it("does not block a changed build that runs the same install script", () => {
    const other = verified({ sourceRepositoryId: "666" });
    const same = {
      current: "install: node-gyp rebuild",
      previous: "install: node-gyp rebuild",
    };
    expect(
      summary(provenanceFindings(change, other, previousIdentity, same)),
    ).toEqual(["warn:install/provenance"]);
  });

  it.each<[string, ProvenanceCheck | "missing" | undefined]>([
    ["no previous version", undefined],
    ["a previous version without provenance", "missing"],
    [
      "a previous version that does not verify",
      { status: "invalid", reason: "x" },
    ],
  ])("compares nothing with %s", (_what, previous) => {
    const other = verified({ sourceRepositoryId: "666" });
    expect(provenanceFindings(change, other, previous, newScript)).toEqual([]);
  });
});

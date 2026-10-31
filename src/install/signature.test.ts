import { describe, expect, it } from "vitest";
import type { PlanChange } from "./plan.ts";
import type { VersionFacts } from "./registry.ts";
import { signatureFindings } from "./signature.ts";
import { TEST_REGISTRY_KEY, testSignature } from "./test-registry.ts";

const SIGNED = "sha512-c2lnbmVk";
const change = (integrity: string | undefined): PlanChange => ({
  kind: "added",
  entry: {
    path: "node_modules/p",
    name: "p",
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/p/-/p-1.0.0.tgz",
    integrity,
    hasInstallScript: false,
    link: false,
    dev: false,
    optional: false,
    os: [],
    cpu: [],
  },
});
const facts = (dist: { integrity?: string; signatures?: unknown }) =>
  ({
    published: new Date("2026-01-01"),
    integrity: dist.integrity,
    signatures: dist.signatures,
  }) as VersionFacts;
const keys = [TEST_REGISTRY_KEY];
const findings = (
  lock: string | undefined,
  dist: Parameters<typeof facts>[0],
) => signatureFindings(change(lock), facts(dist), keys);

describe("signatureFindings", () => {
  const good = [testSignature("p", "1.0.0", SIGNED)];

  it("is silent when the signature verifies and the lockfile has the signed hash", () => {
    expect(findings(SIGNED, { integrity: SIGNED, signatures: good })).toEqual(
      [],
    );
  });

  it("notes a lockfile with no sha512 to compare (old sha1 lockfiles)", () => {
    expect(
      findings("sha1-abc", { integrity: SIGNED, signatures: good }),
    ).toEqual([
      expect.objectContaining({
        severity: "info",
        message: expect.stringContaining("only a sha1"),
      }),
    ]);
  });

  it("leaves a lockfile entry with no hash at all to install/integrity", () => {
    expect(
      findings(undefined, { integrity: SIGNED, signatures: good }),
    ).toEqual([]);
  });

  it("blocks a signature that does not verify", () => {
    const forged = [testSignature("p", "1.0.0", "sha512-other")];
    expect(findings(SIGNED, { integrity: SIGNED, signatures: forged })).toEqual(
      [
        expect.objectContaining({
          ruleId: "install/signature",
          severity: "block",
          file: "p@1.0.0",
        }),
      ],
    );
  });

  it("blocks a lockfile locked to a hash the registry did not sign", () => {
    expect(
      findings("sha512-bG9ja2Vk", { integrity: SIGNED, signatures: good }),
    ).toEqual([
      expect.objectContaining({
        severity: "block",
        message: expect.stringContaining("not the one the registry signed"),
      }),
    ]);
  });

  it("compares the sha512 in a lockfile that lists several hashes", () => {
    expect(
      findings(`sha1-abc ${SIGNED}`, { integrity: SIGNED, signatures: good }),
    ).toEqual([]);
  });

  it.each([
    ["no signature", { integrity: SIGNED }, "no registry signature"],
    ["no integrity", {}, "no integrity hash"],
    [
      "an unknown key",
      { integrity: SIGNED, signatures: [{ keyid: "SHA256:new", sig: "AA==" }] },
      "cannot check",
    ],
  ])("warns on %s", (_what, dist, text) => {
    expect(findings(SIGNED, dist)).toEqual([
      expect.objectContaining({
        severity: "warn",
        message: expect.stringContaining(text),
      }),
    ]);
  });

  it("checks against npm's pinned keys by default", () => {
    expect(
      signatureFindings(
        change(SIGNED),
        facts({ integrity: SIGNED, signatures: good }),
      ),
    ).toEqual([expect.objectContaining({ severity: "warn" })]);
  });
});

import { describe, expect, it } from "vitest";
import { SIGSTORE_PUBLIC_GOOD, verifyProvenance } from "../crypto/sigstore.ts";
import {
  isTestSigner,
  TEST_SIGSTORE,
  testProvenanceBundle,
} from "./test-sigstore.ts";

const subject = {
  name: "@acme/widget",
  version: "2.0.0",
  integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
};

describe("testProvenanceBundle", () => {
  it.each([
    ["acme", "https://github.com/acme/widget", "1001"],
    ["acme-renamed", "https://github.com/acme-labs/widget", "1001"],
    ["mallory", "https://github.com/mallory/widget", "6666"],
  ] as const)("signs a bundle croak verifies as %s", (signer, repo, id) => {
    const result = verifyProvenance(
      testProvenanceBundle(subject, signer),
      subject,
      TEST_SIGSTORE,
    );
    expect(result).toMatchObject({
      status: "verified",
      loggedAt: new Date("2026-01-01T00:00:00Z"),
      identity: {
        sourceRepositoryUri: repo,
        sourceRepositoryId: id,
        buildConfigUri: `${repo}/.github/workflows/release.yml@refs/heads/main`,
      },
    });
  });

  it("is about one tarball only", () => {
    const bundle = testProvenanceBundle(subject, "acme");
    expect(
      verifyProvenance(bundle, { ...subject, version: "2.0.1" }, TEST_SIGSTORE)
        .status,
    ).toBe("invalid");
  });

  it("is trusted by nothing but the test roots", () => {
    const bundle = testProvenanceBundle(subject, "acme");
    expect(verifyProvenance(bundle, subject).status).toBe("unverifiable");
    expect(
      verifyProvenance(bundle, subject, {
        fulcio: SIGSTORE_PUBLIC_GOOD.fulcio,
        rekor: TEST_SIGSTORE.rekor,
      }),
    ).toMatchObject({
      status: "invalid",
      reason: expect.stringContaining("does not chain"),
    });
  });

  it("is invalid when logged outside the test certificates' lifetime", () => {
    const bundle = testProvenanceBundle(
      subject,
      "acme",
      new Date("2040-01-01T00:00:00Z"),
    );
    expect(verifyProvenance(bundle, subject, TEST_SIGSTORE).status).toBe(
      "invalid",
    );
  });

  it("names its signers", () => {
    expect([
      isTestSigner("acme"),
      isTestSigner("toString"),
      isTestSigner(1),
    ]).toEqual([true, false, false]);
  });
});

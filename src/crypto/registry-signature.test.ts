import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkRegistrySignature,
  NPM_REGISTRY_KEYS,
  type RegistryKey,
} from "./registry-signature.ts";

// semver@7.7.2 as registry.npmjs.org published it (fetched 2026-10-31).
const SEMVER = {
  name: "semver",
  version: "7.7.2",
  integrity:
    "sha512-RF0Fw+rO5AMf9MAyaRXI4AV0Ulj5lMHqVxxdSgiVbixSCXoEmmX/jk0CuJw4+3SqroYO9VoUh+HcuJivvtJemA==",
  signatures: [
    {
      sig: "MEQCIBWgpqrE5Kqf9YKjIum5n0B6fPDkhrQ2Uf5DKmopfaS5AiBcu38UXAKlgwXKCiOnWMjRjjo4YSVB/6f2YaHE284k7g==",
      keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
    },
  ],
  published: new Date("2025-05-12T00:00:00Z"),
};

/** A throwaway registry key and a signer for it. */
function testKey(keyid: string, expires?: Date) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const key: RegistryKey = { keyid, publicKey, expires };
  const signFor = (name: string, version: string, integrity: string) =>
    sign(
      "sha256",
      Buffer.from(`${name}@${version}:${integrity}`),
      privateKey,
    ).toString("base64");
  return { key, signFor };
}

describe("checkRegistrySignature", () => {
  it("accepts a real npm registry signature with the pinned keys", () => {
    expect(checkRegistrySignature(SEMVER)).toEqual({
      status: "valid",
      keyid: SEMVER.signatures[0]?.keyid,
    });
  });

  it.each([
    ["another version", { version: "7.7.3" }],
    ["another name", { name: "semvr" }],
    [
      "another integrity",
      { integrity: SEMVER.integrity.replace("RF0F", "RF0G") },
    ],
  ])("rejects the signature for %s", (_what, change) => {
    expect(checkRegistrySignature({ ...SEMVER, ...change })).toMatchObject({
      status: "invalid",
    });
  });

  it("rejects a signature that is not DER or not base64", () => {
    for (const sig of ["", "bm90IGEgc2lnbmF0dXJl", "%%%"]) {
      const signatures = [{ ...SEMVER.signatures[0], sig }];
      expect(checkRegistrySignature({ ...SEMVER, signatures })).toMatchObject({
        status: "invalid",
      });
    }
  });

  it("reports a version without signatures as unsigned", () => {
    for (const signatures of [undefined, [], "x", [{ keyid: 1, sig: 2 }]]) {
      expect(checkRegistrySignature({ ...SEMVER, signatures })).toEqual({
        status: "unsigned",
      });
    }
  });

  it("cannot verify a key croak does not know (a rotation croak missed)", () => {
    const signatures = [{ ...SEMVER.signatures[0], keyid: "SHA256:new" }];
    expect(checkRegistrySignature({ ...SEMVER, signatures })).toMatchObject({
      status: "unverifiable",
      reason: expect.stringContaining("SHA256:new"),
    });
  });

  it("is invalid when any signature by a known key fails, even next to a valid one", () => {
    const a = testKey("A");
    const b = testKey("B");
    const pkg = { name: "x", version: "1.0.0", integrity: "sha512-x" };
    const signatures = [
      { keyid: "A", sig: a.signFor("x", "1.0.0", "sha512-x") },
      { keyid: "B", sig: b.signFor("x", "1.0.0", "sha512-other") },
    ];
    expect(
      checkRegistrySignature({ ...pkg, signatures }, [a.key, b.key]),
    ).toMatchObject({ status: "invalid" });
  });

  it("ignores a signature by an unknown key next to a valid one", () => {
    const a = testKey("A");
    const signatures = [
      { keyid: "A", sig: a.signFor("x", "1.0.0", "sha512-x") },
      { keyid: "Z", sig: "AAAA" },
    ];
    expect(
      checkRegistrySignature(
        { name: "x", version: "1.0.0", integrity: "sha512-x", signatures },
        [a.key],
      ),
    ).toEqual({ status: "valid", keyid: "A" });
  });

  describe("expired keys", () => {
    const expires = new Date("2025-01-29T00:00:00Z");
    const old = testKey("OLD", expires);
    const pkg = (published: Date | undefined) => ({
      name: "x",
      version: "1.0.0",
      integrity: "sha512-x",
      signatures: [
        { keyid: "OLD", sig: old.signFor("x", "1.0.0", "sha512-x") },
      ],
      published,
    });

    it("accepts a version published before the key expired", () => {
      expect(
        checkRegistrySignature(pkg(new Date("2024-06-01Z")), [old.key]),
      ).toMatchObject({ status: "valid" });
    });

    it("rejects a version published after the key expired", () => {
      expect(
        checkRegistrySignature(pkg(new Date("2025-06-01Z")), [old.key]),
      ).toMatchObject({
        status: "invalid",
        reason: expect.stringContaining("expired"),
      });
    });

    it("cannot verify an expiring key without a publish time", () => {
      expect(checkRegistrySignature(pkg(undefined), [old.key])).toMatchObject({
        status: "unverifiable",
      });
    });
  });

  it("pins npm's two registry keys, the old one expired", () => {
    expect(
      NPM_REGISTRY_KEYS.map((k) => [k.keyid, k.expires?.toISOString()]),
    ).toEqual([
      [
        "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA",
        "2025-01-29T00:00:00.000Z",
      ],
      ["SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U", undefined],
    ]);
  });
});

import { generateKeyPairSync, sign } from "node:crypto";
import type { RegistryKey } from "../crypto/registry-signature.ts";

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

/** A throwaway registry key for tests and the eval's fake registry. */
export const TEST_REGISTRY_KEY: RegistryKey = {
  keyid: "SHA256:croak-test-key",
  publicKey,
  expires: undefined,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the registry would put in dist.signatures, signed with the test key. */
export function testSignature(
  name: string,
  version: string,
  integrity: string,
): { keyid: string; sig: string } {
  const sig = sign(
    "sha256",
    Buffer.from(`${name}@${version}:${integrity}`),
    privateKey,
  );
  return { keyid: TEST_REGISTRY_KEY.keyid, sig: sig.toString("base64") };
}

/**
 * Signs each version like the registry does: dist.integrity (or the one
 * `integrityOf` gives) gets a signature by the test key. A version that
 * states its own dist.signatures keeps them (with the integrity filled in),
 * so a fixture can carry a forged one; a version with no integrity at all
 * stays unsigned.
 */
export function signPackument(
  doc: unknown,
  integrityOf: (version: string) => string | undefined = () => undefined,
): unknown {
  if (!isRecord(doc) || !isRecord(doc.versions)) return doc;
  const name = typeof doc.name === "string" ? doc.name : "";
  const versions = Object.fromEntries(
    Object.entries(doc.versions).map(([version, meta]) => {
      const record = isRecord(meta) ? meta : {};
      const dist = isRecord(record.dist) ? record.dist : {};
      const integrity =
        typeof dist.integrity === "string"
          ? dist.integrity
          : integrityOf(version);
      if (integrity === undefined) return [version, record];
      const signatures = dist.signatures ?? [
        testSignature(name, version, integrity),
      ];
      return [version, { ...record, dist: { ...dist, integrity, signatures } }];
    }),
  );
  return { ...doc, versions };
}

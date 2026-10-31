import { createPublicKey, type KeyObject, verify } from "node:crypto";

/**
 * npm registry signatures (M7, D42): the registry signs
 * `name@version:integrity` with ECDSA P-256 (SHA-256), so a signature binds a
 * version to the tarball hash the registry published. It says the tarball is
 * what the registry has, nothing about who built it (that is provenance).
 */

export interface RegistryKey {
  readonly keyid: string;
  readonly publicKey: KeyObject;
  /** Signatures by this key are good only for versions published before this. */
  readonly expires: Date | undefined;
}

const p256 = (spkiBase64: string): KeyObject =>
  createPublicKey({
    key: Buffer.from(spkiBase64, "base64"),
    format: "der",
    type: "spki",
  });

/**
 * registry.npmjs.org/-/npm/v1/keys, pinned 2026-10-31 (D42). Pinned, not
 * fetched: keys from the same server as the packument would only check the
 * server against itself. A key croak does not know is "unverifiable", never
 * a pass.
 */
export const NPM_REGISTRY_KEYS: readonly RegistryKey[] = [
  {
    keyid: "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA",
    publicKey: p256(
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==",
    ),
    expires: new Date("2025-01-29T00:00:00.000Z"),
  },
  {
    keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
    publicKey: p256(
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==",
    ),
    expires: undefined,
  },
];

export interface SignedVersion {
  readonly name: string;
  readonly version: string;
  /** The registry's dist.integrity: the hash the signature covers. */
  readonly integrity: string;
  /** The registry's dist.signatures, as found (untrusted shape). */
  readonly signatures: unknown;
  /** When the registry says the version was published. */
  readonly published?: Date | undefined;
}

export type SignatureCheck =
  | { readonly status: "valid"; readonly keyid: string }
  /** A known key's signature does not match, or postdates the key's expiry. */
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "unsigned" }
  /** Signed, but croak cannot tell whether the signature is good. */
  | { readonly status: "unverifiable"; readonly reason: string };

interface Signature {
  readonly keyid: string;
  readonly sig: string;
}

function signaturesOf(value: unknown): Signature[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is Signature =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as Record<string, unknown>).keyid === "string" &&
      typeof (s as Record<string, unknown>).sig === "string",
  );
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function verifies(message: Buffer, key: KeyObject, sig: string): boolean {
  if (sig === "" || !BASE64.test(sig)) return false;
  try {
    return verify("sha256", message, key, Buffer.from(sig, "base64"));
  } catch {
    // Malformed DER is a bad signature, not a crash.
    return false;
  }
}

/**
 * Like npm's own check: every signature by a known key must verify, and a
 * key past its expiry signs nothing published after it. Signatures by keys
 * croak does not know are skipped while a known one verifies.
 */
export function checkRegistrySignature(
  pkg: SignedVersion,
  keys: readonly RegistryKey[] = NPM_REGISTRY_KEYS,
): SignatureCheck {
  const signatures = signaturesOf(pkg.signatures);
  if (signatures.length === 0) return { status: "unsigned" };
  const message = Buffer.from(`${pkg.name}@${pkg.version}:${pkg.integrity}`);
  const unknown: string[] = [];
  let valid: string | undefined;
  for (const { keyid, sig } of signatures) {
    const key = keys.find((k) => k.keyid === keyid);
    if (key === undefined) {
      unknown.push(keyid);
      continue;
    }
    if (key.expires !== undefined) {
      if (pkg.published === undefined)
        return {
          status: "unverifiable",
          reason: `key ${keyid} expired on ${key.expires.toISOString()} and the registry gives no publish time`,
        };
      if (pkg.published.getTime() > key.expires.getTime())
        return {
          status: "invalid",
          reason: `signed with key ${keyid}, which expired before this version was published`,
        };
    }
    if (!verifies(message, key.publicKey, sig))
      return {
        status: "invalid",
        reason: `the signature by key ${keyid} does not match ${pkg.name}@${pkg.version} and its integrity`,
      };
    valid ??= keyid;
  }
  return valid !== undefined
    ? { status: "valid", keyid: valid }
    : {
        status: "unverifiable",
        reason: `signed only with keys croak does not know (${unknown.join(", ")}); a newer croak may know them`,
      };
}

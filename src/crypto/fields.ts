import { type KeyObject, verify, X509Certificate } from "node:crypto";

/**
 * Reading Sigstore bundles, which come from the registry: every field is
 * checked for shape before it is used (M7, D43).
 */

/** Why a bundle check stopped: it is wrong, or croak cannot tell. */
export class SigstoreError extends Error {
  readonly status: "invalid" | "unverifiable";
  constructor(status: "invalid" | "unverifiable", message: string) {
    super(message);
    this.name = "SigstoreError";
    this.status = status;
  }
}

export const invalid = (message: string): SigstoreError =>
  new SigstoreError("invalid", message);
export const unverifiable = (message: string): SigstoreError =>
  new SigstoreError("unverifiable", message);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The string at `path` inside `value`; anything else is an invalid bundle. */
export function str(value: unknown, ...path: (string | number)[]): string {
  let at: unknown = value;
  for (const key of path) {
    at =
      Array.isArray(at) && typeof key === "number"
        ? at[key]
        : isRecord(at)
          ? at[key]
          : undefined;
  }
  if (typeof at !== "string")
    throw invalid(`the bundle has no ${path.join(".")}`);
  return at;
}

export function b64(text: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    throw invalid("a bundle field is not base64");
  return Buffer.from(text, "base64");
}

export function certFrom(der: Buffer, what: string): X509Certificate {
  try {
    return new X509Certificate(der);
  } catch {
    throw invalid(`${what} is not a certificate`);
  }
}

/**
 * A SHA-256 signature check that answers false instead of throwing: keys
 * and signatures come from the registry, and node:crypto throws on some
 * (an Ed25519 key with a digest, malformed DER).
 */
export function verifies(
  data: Buffer,
  key: KeyObject,
  signature: Buffer,
): boolean {
  try {
    return verify("sha256", data, key, signature);
  } catch {
    return false;
  }
}

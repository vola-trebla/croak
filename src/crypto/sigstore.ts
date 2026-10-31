import { createHash, verify, type X509Certificate } from "node:crypto";
import { type BuildIdentity, DerError, fulcioIdentity } from "./der.ts";
import {
  b64,
  certFrom,
  invalid,
  isRecord,
  SigstoreError,
  str,
  unverifiable,
} from "./fields.ts";
import { REKOR_V1, type RekorLog, readLogEntry } from "./rekor.ts";

/**
 * A minimal Sigstore verifier for npm provenance bundles (M7, D42, D43):
 * Rekor promised (SET) to have logged this envelope and certificate at a
 * time the certificate was valid, the certificate chains to Fulcio, the
 * DSSE envelope is signed by it, and the in-toto subject is this tarball.
 * Who built it comes from the certificate, not from the statement.
 */

export interface SigstoreTrustRoot {
  /** Fulcio's chain: the issuing intermediate first, the root last. */
  readonly fulcio: readonly X509Certificate[];
  readonly rekor: RekorLog;
}

const pinned = (base64: string): X509Certificate =>
  certFrom(Buffer.from(base64, "base64"), "a pinned Fulcio certificate");

/**
 * Sigstore's public-good instance, pinned 2026-10-31 from
 * github.com/sigstore/root-signing targets/trusted_root.json (D42): the
 * Fulcio CA valid since 2022-04-13 (npm provenance began in 2023).
 */
export const SIGSTORE_PUBLIC_GOOD: SigstoreTrustRoot = {
  fulcio: [
    pinned(
      "MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0yMjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEeMBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9NlarYpAd9HP1vBBH1U5CV77LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS0N/RgBJz/9jWCiXno3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Ppz1YkEZb5qNjpKFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZIzj0EAwMDZwAwZAIwPCsQK4DYiZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJRnZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3BxsPmygUY7Ii2zbdCdliiow=",
    ),
    pinned(
      "MIIB9zCCAXygAwIBAgIUALZNAPFdxHPwjeDloDwyYChAO/4wCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0yMTEwMDcxMzU2NTlaFw0zMTEwMDUxMzU2NThaMCoxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjERMA8GA1UEAxMIc2lnc3RvcmUwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT7XeFT4rb3PQGwS4IajtLk3/OlnpgangaBclYpsYBr5i+4ynB07ceb3LP0OIOZdxexX69c5iVuyJRQ+Hz05yi+UF3uBWAlHpiS5sh0+H2GHE7SXrk1EC5m1Tr19L9gg92jYzBhMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRYwB5fkUWlZql6zJChkyLQKsXF+jAfBgNVHSMEGDAWgBRYwB5fkUWlZql6zJChkyLQKsXF+jAKBggqhkjOPQQDAwNpADBmAjEAj1nHeXZp+13NWBNa+EDsDP8G1WWg1tCMWP/WHPqpaVo0jhsweNFZgSs0eE7wYI4qAjEA2WB9ot98sIkoF3vZYdd3/VtWB5b9TNMea7Ix/stJ5TfcLLeABLE4BNJOsQ4vnBHJ",
    ),
  ],
  rekor: REKOR_V1,
};

export interface Subject {
  readonly name: string;
  readonly version: string;
  /** The registry's dist.integrity; its sha512 must be the attested digest. */
  readonly integrity: string;
}

export type ProvenanceCheck =
  | {
      readonly status: "verified";
      readonly identity: BuildIdentity;
      readonly loggedAt: Date;
    }
  /** The bundle claims something its signatures do not back. */
  | { readonly status: "invalid"; readonly reason: string }
  /** A shape or log croak does not support: it cannot tell either way. */
  | { readonly status: "unverifiable"; readonly reason: string };

const CODE_SIGNING = "1.3.6.1.5.5.7.3.3";

function leafOf(material: unknown): X509Certificate {
  const raw =
    isRecord(material) && isRecord(material.certificate)
      ? str(material, "certificate", "rawBytes")
      : str(material, "x509CertificateChain", "certificates", 0, "rawBytes");
  return certFrom(b64(raw), "the signing certificate");
}

function checkCertificate(
  leaf: X509Certificate,
  chain: readonly X509Certificate[],
  at: Date,
): void {
  let child = leaf;
  for (const issuer of chain) {
    if (!child.checkIssued(issuer) || !child.verify(issuer.publicKey))
      throw invalid("the signing certificate does not chain to Fulcio");
    if (at < issuer.validFromDate || at > issuer.validToDate)
      throw invalid("Fulcio's certificate was not valid when this was logged");
    child = issuer;
  }
  if (leaf.ca) throw invalid("the signing certificate is a CA");
  if (!(leaf.keyUsage ?? []).includes(CODE_SIGNING))
    throw invalid("the signing certificate is not for code signing");
  if (at < leaf.validFromDate || at > leaf.validToDate)
    throw invalid("it was logged outside the signing certificate's lifetime");
}

/** DSSE's pre-authentication encoding: what the envelope signature covers. */
const pae = (type: string, payload: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `),
    payload,
  ]);

/** A package URL with its escapes undone (npm writes `pkg:npm/%40scope/name@1.0.0`). */
function purlName(purl: string): string {
  try {
    return decodeURIComponent(purl);
  } catch {
    throw invalid("the attestation's subject is not a valid package URL");
  }
}

function checkSubject(payload: Buffer, subject: Subject): void {
  let statement: unknown;
  try {
    statement = JSON.parse(payload.toString("utf8"));
  } catch {
    throw invalid("the attested statement is not JSON");
  }
  const sha512 = subject.integrity
    .trim()
    .split(/\s+/)
    .find((hash) => hash.startsWith("sha512-"));
  if (sha512 === undefined)
    throw unverifiable("the registry gives no sha512 to compare");
  const digest = b64(sha512.slice("sha512-".length)).toString("hex");
  const want = `pkg:npm/${subject.name}@${subject.version}`;
  const subjects =
    isRecord(statement) && Array.isArray(statement.subject)
      ? statement.subject
      : [];
  const match = subjects.some(
    (_s, i) =>
      purlName(str(statement, "subject", i, "name")) === want &&
      str(statement, "subject", i, "digest", "sha512") === digest,
  );
  if (!match)
    throw invalid(
      `the attestation is not about ${subject.name}@${subject.version} with this tarball`,
    );
}

function check(
  bundle: unknown,
  subject: Subject,
  trust: SigstoreTrustRoot,
): ProvenanceCheck {
  const material = isRecord(bundle) ? bundle.verificationMaterial : undefined;
  const entries =
    isRecord(material) && Array.isArray(material.tlogEntries)
      ? material.tlogEntries
      : [];
  const logged = readLogEntry(entries[0], trust.rekor);

  const leaf = leafOf(material);
  checkCertificate(leaf, trust.fulcio, logged.loggedAt);

  const type = str(bundle, "dsseEnvelope", "payloadType");
  if (type !== "application/vnd.in-toto+json")
    throw invalid(`the envelope carries ${type}, not an in-toto statement`);
  const payload = b64(str(bundle, "dsseEnvelope", "payload"));
  const sig = str(bundle, "dsseEnvelope", "signatures", 0, "sig");
  if (!verify("sha256", pae(type, payload), leaf.publicKey, b64(sig)))
    throw invalid("the envelope's signature does not verify");

  if (
    logged.signature !== sig ||
    !logged.certificateDer.equals(leaf.raw) ||
    logged.payloadHash !== createHash("sha256").update(payload).digest("hex")
  )
    throw invalid("the transparency log entry is for a different signature");

  checkSubject(payload, subject);
  return {
    status: "verified",
    identity: fulcioIdentity(leaf.raw),
    loggedAt: logged.loggedAt,
  };
}

/** Verifies an npm provenance bundle (the SLSA one) for this exact tarball. */
export function verifyProvenance(
  bundle: unknown,
  subject: Subject,
  trust: SigstoreTrustRoot = SIGSTORE_PUBLIC_GOOD,
): ProvenanceCheck {
  try {
    return check(bundle, subject, trust);
  } catch (error) {
    if (error instanceof SigstoreError)
      return { status: error.status, reason: error.message };
    if (error instanceof DerError)
      return { status: "invalid", reason: error.message };
    throw error;
  }
}

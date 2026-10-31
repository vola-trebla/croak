import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify,
} from "node:crypto";
import {
  b64,
  certFrom,
  invalid,
  isRecord,
  str,
  unverifiable,
} from "./fields.ts";

/**
 * Rekor, Sigstore's transparency log (M7, D43). A bundle's log entry carries
 * Rekor's signed entry timestamp (SET): the log's promise that it recorded
 * this entry at this time. The time is what makes a ten-minute Fulcio
 * certificate checkable later.
 */

export interface RekorLog {
  /** base64 SHA-256 of the key's SPKI DER: the log id bundles name. */
  readonly logId: string;
  readonly publicKey: KeyObject;
}

export function rekorLog(spkiBase64: string): RekorLog {
  const der = Buffer.from(spkiBase64, "base64");
  return {
    logId: createHash("sha256").update(der).digest("base64"),
    publicKey: createPublicKey({ key: der, format: "der", type: "spki" }),
  };
}

/**
 * rekor.sigstore.dev, pinned 2026-10-31 from github.com/sigstore/root-signing
 * targets/trusted_root.json (D42). Rekor v2 logs (Ed25519, no SET) are not
 * pinned: their entries are unverifiable (D43).
 */
export const REKOR_V1: RekorLog = rekorLog(
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwrkBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==",
);

/** What the log recorded, once its timestamp verified. */
export interface LoggedEntry {
  readonly loggedAt: Date;
  /** The DSSE signature, as in the envelope (base64). */
  readonly signature: string;
  /** The signing certificate, DER. */
  readonly certificateDer: Buffer;
  /** Hex SHA-256 of the DSSE payload. */
  readonly payloadHash: string;
}

const SUPPORTED = ["dsse 0.0.1", "intoto 0.0.2"];

/** A PEM certificate as Rekor stores it (base64 of the PEM text), as DER. */
const pemCertDer = (base64Pem: string): Buffer =>
  certFrom(b64(base64Pem), "the logged certificate").raw;

/**
 * Verifies the SET over a bundle's log entry and reads what it recorded.
 * Throws a SigstoreError: invalid when the entry is not what the log
 * signed, unverifiable for a log, kind or shape croak does not support.
 */
export function readLogEntry(entry: unknown, log: RekorLog): LoggedEntry {
  const kind = `${str(entry, "kindVersion", "kind")} ${str(entry, "kindVersion", "version")}`;
  if (!SUPPORTED.includes(kind))
    throw unverifiable(`a transparency log entry of kind ${kind}`);
  if (str(entry, "logId", "keyId") !== log.logId)
    throw unverifiable(
      "logged in a transparency log croak does not know (a newer croak may)",
    );
  if (!isRecord(entry) || !isRecord(entry.inclusionPromise))
    throw unverifiable("the log entry has no signed entry timestamp");
  const set = str(entry, "inclusionPromise", "signedEntryTimestamp");

  const integratedTime = str(entry, "integratedTime");
  const logIndex = str(entry, "logIndex");
  if (!/^\d{1,15}$/.test(integratedTime) || !/^\d{1,15}$/.test(logIndex))
    throw invalid("the log entry's time or index is not a number");
  const body = str(entry, "canonicalizedBody");
  // Rekor signs the canonical JSON of these four fields, keys sorted.
  const promise = JSON.stringify({
    body,
    integratedTime: Number(integratedTime),
    logID: b64(log.logId).toString("hex"),
    logIndex: Number(logIndex),
  });
  if (!verify("sha256", Buffer.from(promise), log.publicKey, b64(set)))
    throw invalid("the transparency log's signed timestamp does not verify");

  let logged: unknown;
  try {
    logged = JSON.parse(b64(body).toString("utf8"));
  } catch {
    throw invalid("the log entry's body is not JSON");
  }
  const loggedAt = new Date(Number(integratedTime) * 1000);
  if (kind === "dsse 0.0.1")
    return {
      loggedAt,
      signature: str(logged, "spec", "signatures", 0, "signature"),
      certificateDer: pemCertDer(
        str(logged, "spec", "signatures", 0, "verifier"),
      ),
      payloadHash: str(logged, "spec", "payloadHash", "value"),
    };
  // intoto 0.0.2 stores the signature base64-encoded once more.
  const signer = ["spec", "content", "envelope", "signatures", 0] as const;
  return {
    loggedAt,
    signature: b64(str(logged, ...signer, "sig")).toString("utf8"),
    certificateDer: pemCertDer(str(logged, ...signer, "publicKey")),
    payloadHash: str(logged, "spec", "content", "payloadHash", "value"),
  };
}

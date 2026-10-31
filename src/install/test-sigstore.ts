import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  X509Certificate,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { rekorLog } from "../crypto/rekor.ts";
import type { SigstoreTrustRoot } from "../crypto/sigstore.ts";

/**
 * TEST-ONLY Sigstore for tests and the eval's fake registry: a Fulcio-shaped
 * chain from scripts/gen-test-sigstore.sh and a Rekor key made per run.
 * Nothing but an explicit `sigstore` option trusts it.
 */

const dir = new URL("../crypto/fixtures/test-sigstore/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, dir), "utf8");

/** Build identities with a certificate each (all from .github/workflows/release.yml). */
export const TEST_SIGNERS = {
  /** github.com/acme/widget, repository id 1001. */
  acme: "acme",
  /** The same repository (id 1001), renamed to github.com/acme-labs/widget. */
  "acme-renamed": "acme-renamed",
  /** github.com/mallory/widget, repository id 6666. */
  mallory: "mallory",
} as const;
export type TestSigner = keyof typeof TEST_SIGNERS;

export function isTestSigner(value: unknown): value is TestSigner {
  return typeof value === "string" && Object.hasOwn(TEST_SIGNERS, value);
}

const rekorKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rekor = rekorLog(
  rekorKeys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64"),
);

export const TEST_SIGSTORE: SigstoreTrustRoot = {
  fulcio: [
    new X509Certificate(read("intermediate.pem")),
    new X509Certificate(read("root.pem")),
  ],
  rekor,
};

const sha256hex = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/**
 * An npm SLSA provenance bundle (v0.3, dsse log entry) for this tarball,
 * signed as `signer` and logged at `loggedAt`, as the registry serves it.
 */
export function testProvenanceBundle(
  subject: { name: string; version: string; integrity: string },
  signer: TestSigner,
  loggedAt: Date = new Date("2026-01-01T00:00:00Z"),
): unknown {
  const pem = read(`${signer}.pem`);
  const key = createPrivateKey(read(`${signer}.key`));
  const sha512 = Buffer.from(
    subject.integrity.replace(/^sha512-/, ""),
    "base64",
  ).toString("hex");
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `pkg:npm/${subject.name.replace("@", "%40")}@${subject.version}`,
        digest: { sha512 },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {},
  };
  const payload = Buffer.from(JSON.stringify(statement));
  const type = "application/vnd.in-toto+json";
  const pae = Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} ${type} ${payload.length} `),
    payload,
  ]);
  const sig = sign("sha256", pae, key).toString("base64");
  const body = {
    apiVersion: "0.0.1",
    kind: "dsse",
    spec: {
      payloadHash: { algorithm: "sha256", value: sha256hex(payload) },
      signatures: [
        { signature: sig, verifier: Buffer.from(pem).toString("base64") },
      ],
    },
  };
  const canonicalizedBody = Buffer.from(JSON.stringify(body)).toString(
    "base64",
  );
  const integratedTime = Math.floor(loggedAt.getTime() / 1000);
  const promise = JSON.stringify({
    body: canonicalizedBody,
    integratedTime,
    logID: Buffer.from(rekor.logId, "base64").toString("hex"),
    logIndex: 1,
  });
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      certificate: {
        rawBytes: new X509Certificate(pem).raw.toString("base64"),
      },
      tlogEntries: [
        {
          logIndex: "1",
          logId: { keyId: rekor.logId },
          kindVersion: { kind: "dsse", version: "0.0.1" },
          integratedTime: String(integratedTime),
          inclusionPromise: {
            signedEntryTimestamp: sign(
              "sha256",
              Buffer.from(promise),
              rekorKeys.privateKey,
            ).toString("base64"),
          },
          canonicalizedBody,
        },
      ],
    },
    dsseEnvelope: {
      payload: payload.toString("base64"),
      payloadType: type,
      signatures: [{ sig, keyid: "" }],
    },
  };
}

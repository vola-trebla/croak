import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TEST_SIGSTORE,
  testProvenanceBundle,
} from "../install/test-sigstore.ts";
import { rekorLog } from "./rekor.ts";
import {
  SIGSTORE_PUBLIC_GOOD,
  type SigstoreTrustRoot,
  verifyProvenance,
} from "./sigstore.ts";

// semver's SLSA provenance bundles as npm serves them (fetched 2026-10-31):
// 7.7.2 is a v0.3 bundle with a dsse log entry, 7.5.2 a v0.1 bundle with an
// intoto entry, the shape every 2023 provenance has.
/** The fixture fields these tests touch. */
interface LogEntry {
  kindVersion: { kind: string; version: string };
  logId: { keyId: string };
  integratedTime: string;
  logIndex: string;
  canonicalizedBody: string;
  inclusionPromise?: { signedEntryTimestamp: string };
}
interface Bundle {
  verificationMaterial: {
    certificate?: { rawBytes: string };
    x509CertificateChain?: { certificates: { rawBytes: string }[] };
    tlogEntries: LogEntry[];
  };
  dsseEnvelope?: {
    payload: string;
    payloadType: string;
    signatures: { sig: string }[];
  };
}

const load = (file: string): Bundle =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"),
  );
const NEW = load("semver-7.7.2-provenance.json");
const OLD = load("semver-7.5.2-provenance.json");
const NEW_SUBJECT = {
  name: "semver",
  version: "7.7.2",
  integrity:
    "sha512-RF0Fw+rO5AMf9MAyaRXI4AV0Ulj5lMHqVxxdSgiVbixSCXoEmmX/jk0CuJw4+3SqroYO9VoUh+HcuJivvtJemA==",
};

function entryOf(b: Bundle): LogEntry {
  const entry = b.verificationMaterial.tlogEntries[0];
  if (entry === undefined) throw new Error("fixture has no log entry");
  return entry;
}
function envelopeOf(b: Bundle): NonNullable<Bundle["dsseEnvelope"]> {
  if (b.dsseEnvelope === undefined) throw new Error("fixture has no envelope");
  return b.dsseEnvelope;
}
const OLD_SIG = envelopeOf(OLD).signatures[0]?.sig ?? "";
const OLD_CERT =
  OLD.verificationMaterial.x509CertificateChain?.certificates[0]?.rawBytes ??
  "";

/** A deep copy with one change, made by `edit`. */
function tampered(bundle: Bundle, edit: (b: Bundle) => void): unknown {
  const copy = structuredClone(bundle);
  edit(copy);
  return copy;
}
const setCert = (b: Bundle, rawBytes: string): void => {
  b.verificationMaterial.certificate = { rawBytes };
};

describe("verifyProvenance", () => {
  it("verifies a real npm provenance bundle and reads who built it", () => {
    const result = verifyProvenance(NEW, NEW_SUBJECT);
    expect(result).toMatchObject({
      status: "verified",
      loggedAt: new Date("2025-05-12T17:02:26Z"),
      identity: {
        sourceRepositoryUri: "https://github.com/npm/node-semver",
        sourceRepositoryDigest: "281055e7716ef0415a8826972471331989ede58c",
        buildConfigUri:
          "https://github.com/npm/node-semver/.github/workflows/release.yml@refs/heads/main",
      },
    });
  });

  it("verifies the 2023 shape: a v0.1 bundle and an intoto log entry", () => {
    const statement = JSON.parse(
      Buffer.from(envelopeOf(OLD).payload, "base64").toString(),
    );
    const integrity = `sha512-${Buffer.from(statement.subject[0].digest.sha512, "hex").toString("base64")}`;
    expect(
      verifyProvenance(OLD, { name: "semver", version: "7.5.2", integrity }),
    ).toMatchObject({
      status: "verified",
      identity: { sourceRepositoryUri: "https://github.com/npm/node-semver" },
    });
  });

  it.each([
    ["another version", { version: "7.7.3" }],
    ["another name", { name: "semvr" }],
    ["another tarball", { integrity: `sha512-${"A".repeat(86)}==` }],
  ])("rejects it for %s", (_what, change) => {
    expect(verifyProvenance(NEW, { ...NEW_SUBJECT, ...change })).toMatchObject({
      status: "invalid",
      reason: expect.stringContaining("not about"),
    });
  });

  it.each<[string, (b: Bundle) => void, string]>([
    [
      "a changed statement",
      (b) => {
        const envelope = envelopeOf(b);
        const payload = Buffer.from(envelope.payload, "base64");
        payload.writeUInt8(
          payload.readUInt8(payload.length - 2) ^ 1,
          payload.length - 2,
        );
        envelope.payload = payload.toString("base64");
      },
      "envelope's signature",
    ],
    [
      "another envelope signature",
      (b) => {
        envelopeOf(b).signatures = [{ sig: OLD_SIG }];
      },
      "envelope's signature",
    ],
    [
      "another signing certificate",
      (b) => {
        setCert(b, OLD_CERT);
      },
      "lifetime",
    ],
    [
      "a certificate that is not one",
      (b) => {
        setCert(b, "AAAA");
      },
      "not a certificate",
    ],
    [
      "a Fulcio root certificate as the signer",
      (b) => {
        setCert(
          b,
          SIGSTORE_PUBLIC_GOOD.fulcio[1]?.raw.toString("base64") ?? "",
        );
      },
      "does not chain",
    ],
    [
      "a statement that is not in-toto",
      (b) => {
        envelopeOf(b).payloadType = "text/plain";
      },
      "not an in-toto",
    ],
    [
      "a missing envelope",
      (b) => {
        delete b.dsseEnvelope;
      },
      "dsseEnvelope",
    ],
  ])("rejects %s", (_what, edit, reason) => {
    expect(verifyProvenance(tampered(NEW, edit), NEW_SUBJECT)).toMatchObject({
      status: "invalid",
      reason: expect.stringContaining(reason),
    });
  });

  it.each<[string, (b: Bundle) => void]>([
    [
      "a log croak does not know (Rekor v2)",
      (b) => {
        entryOf(b).logId.keyId = "zxGZFVvd0FEmjR8WrFwMdcAJ9vtaY/QXf44Y1wUeP6A=";
      },
    ],
  ])("passes on what Rekor cannot verify: %s", (_what, edit) => {
    expect(verifyProvenance(tampered(NEW, edit), NEW_SUBJECT)).toMatchObject({
      status: "unverifiable",
    });
  });

  it.each([null, "x", {}, []])("rejects a bundle shaped like %j", (bundle) => {
    expect(verifyProvenance(bundle, NEW_SUBJECT).status).toBe("invalid");
  });

  it("rejects a log entry for another signature, even with a good timestamp", () => {
    // A log key of our own, so the timestamp over a doctored body verifies
    // and the body check is what has to catch it.
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const trust: SigstoreTrustRoot = {
      fulcio: SIGSTORE_PUBLIC_GOOD.fulcio,
      rekor: rekorLog(
        publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      ),
    };
    const bundle = tampered(NEW, (b) => {
      const entry = entryOf(b);
      const body: { spec: { signatures: { signature: string }[] } } =
        JSON.parse(Buffer.from(entry.canonicalizedBody, "base64").toString());
      body.spec.signatures = body.spec.signatures.map((s) => ({
        ...s,
        signature: OLD_SIG,
      }));
      entry.canonicalizedBody = Buffer.from(JSON.stringify(body)).toString(
        "base64",
      );
      entry.logId.keyId = trust.rekor.logId;
      const promise = JSON.stringify({
        body: entry.canonicalizedBody,
        integratedTime: Number(entry.integratedTime),
        logID: Buffer.from(trust.rekor.logId, "base64").toString("hex"),
        logIndex: Number(entry.logIndex),
      });
      entry.inclusionPromise = {
        signedEntryTimestamp: sign(
          "sha256",
          Buffer.from(promise),
          privateKey,
        ).toString("base64"),
      };
    });
    expect(verifyProvenance(bundle, NEW_SUBJECT, trust)).toMatchObject({
      status: "invalid",
      reason: expect.stringContaining("different signature"),
    });
  });

  it("pins the public-good Fulcio chain and the Rekor v1 log", () => {
    expect(SIGSTORE_PUBLIC_GOOD.fulcio.map((c) => c.subject)).toEqual([
      "O=sigstore.dev\nCN=sigstore-intermediate",
      "O=sigstore.dev\nCN=sigstore",
    ]);
    expect(SIGSTORE_PUBLIC_GOOD.rekor.logId).toBe(
      "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=",
    );
  });
});

describe("verifyProvenance with test certificates", () => {
  const subject = {
    name: "widget",
    version: "2.0.0",
    integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
  };

  it("cannot verify a signing key that is not EC or RSA, and does not throw", () => {
    const bundle = testProvenanceBundle(subject, "acme-ed25519");
    expect(verifyProvenance(bundle, subject, TEST_SIGSTORE)).toMatchObject({
      status: "unverifiable",
      reason: expect.stringContaining("ed25519"),
    });
  });
});

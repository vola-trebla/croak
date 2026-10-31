import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SigstoreError } from "./fields.ts";
import { REKOR_V1, type RekorLog, readLogEntry, rekorLog } from "./rekor.ts";

/** The fixture fields these tests touch. */
interface Entry {
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
    tlogEntries: Entry[];
  };
  dsseEnvelope: { payload: string; signatures: { sig: string }[] };
}

// semver's provenance bundles as npm serves them (fetched 2026-10-31):
// 7.7.2 has a dsse log entry, 7.5.2 the 2023 intoto shape.
const load = (file: string): Bundle =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"),
  );
const NEW = load("semver-7.7.2-provenance.json");
const OLD = load("semver-7.5.2-provenance.json");

function entryOf(b: Bundle): Entry {
  const entry = b.verificationMaterial.tlogEntries[0];
  if (entry === undefined) throw new Error("fixture has no log entry");
  return entry;
}
const certOf = (b: Bundle): string =>
  b.verificationMaterial.certificate?.rawBytes ??
  b.verificationMaterial.x509CertificateChain?.certificates[0]?.rawBytes ??
  "";
const sha256hex = (base64: string): string =>
  createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");

/** A copy of the bundle's entry with one change. */
function changed(b: Bundle, edit: (e: Entry) => void): Entry {
  const copy = structuredClone(entryOf(b));
  edit(copy);
  return copy;
}

/** A log of our own, to sign entries the real log never saw. */
function ownLog(): { log: RekorLog; signSet: (e: Entry) => void } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const log = rekorLog(
    publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  );
  const signSet = (e: Entry): void => {
    e.logId.keyId = log.logId;
    const promise = JSON.stringify({
      body: e.canonicalizedBody,
      integratedTime: Number(e.integratedTime),
      logID: Buffer.from(log.logId, "base64").toString("hex"),
      logIndex: Number(e.logIndex),
    });
    e.inclusionPromise = {
      signedEntryTimestamp: sign(
        "sha256",
        Buffer.from(promise),
        privateKey,
      ).toString("base64"),
    };
  };
  return { log, signSet };
}

const statusOf = (entry: unknown, log: RekorLog = REKOR_V1): string => {
  try {
    readLogEntry(entry, log);
    return "read";
  } catch (error) {
    if (error instanceof SigstoreError) return error.status;
    throw error;
  }
};

describe("readLogEntry", () => {
  it.each([
    ["a dsse entry (7.7.2)", NEW, "2025-05-12T17:02:26.000Z"],
    ["an intoto entry (7.5.2, the 2023 shape)", OLD, undefined],
  ])("reads what Rekor logged for %s", (_what, bundle, at) => {
    const logged = readLogEntry(entryOf(bundle), REKOR_V1);
    expect(logged.signature).toBe(bundle.dsseEnvelope.signatures[0]?.sig);
    expect(logged.certificateDer.toString("base64")).toBe(certOf(bundle));
    expect(logged.payloadHash).toBe(sha256hex(bundle.dsseEnvelope.payload));
    if (at !== undefined) expect(logged.loggedAt.toISOString()).toBe(at);
  });

  it.each<[string, (e: Entry) => void]>([
    [
      "a shifted time",
      (e) => {
        e.integratedTime = String(Number(e.integratedTime) + 1);
      },
    ],
    [
      "another index",
      (e) => {
        e.logIndex = "1";
      },
    ],
    [
      "another entry's body",
      (e) => {
        e.canonicalizedBody = entryOf(OLD).canonicalizedBody;
      },
    ],
    [
      "a time that is not a number",
      (e) => {
        e.integratedTime = "1e9";
      },
    ],
    [
      "a timestamp that is not base64",
      (e) => {
        e.inclusionPromise = { signedEntryTimestamp: "%%" };
      },
    ],
  ])("rejects an entry with %s", (_what, edit) => {
    expect(statusOf(changed(NEW, edit))).toBe("invalid");
  });

  it.each<[string, (e: Entry) => void]>([
    [
      "a log croak does not pin (Rekor v2)",
      (e) => {
        e.logId.keyId = "zxGZFVvd0FEmjR8WrFwMdcAJ9vtaY/QXf44Y1wUeP6A=";
      },
    ],
    [
      "no signed timestamp",
      (e) => {
        delete e.inclusionPromise;
      },
    ],
    [
      "a kind croak does not read",
      (e) => {
        e.kindVersion = { kind: "hashedrekord", version: "0.0.1" };
      },
    ],
  ])("cannot verify an entry with %s", (_what, edit) => {
    expect(statusOf(changed(NEW, edit))).toBe("unverifiable");
  });

  it.each([null, "x", {}, []])("rejects an entry shaped like %j", (entry) => {
    expect(statusOf(entry)).toBe("invalid");
  });

  it("reports what a log signed, so a doctored body cannot pass for the envelope", () => {
    const { log, signSet } = ownLog();
    const entry = changed(NEW, (e) => {
      const body = JSON.parse(
        Buffer.from(e.canonicalizedBody, "base64").toString(),
      );
      body.spec.signatures[0].signature = "doctored";
      e.canonicalizedBody = Buffer.from(JSON.stringify(body)).toString(
        "base64",
      );
      signSet(e);
    });
    expect(readLogEntry(entry, log).signature).toBe("doctored");
    expect(statusOf(entry)).toBe("unverifiable");
  });

  it("rejects a signed body that is not JSON", () => {
    const { log, signSet } = ownLog();
    const entry = changed(NEW, (e) => {
      e.canonicalizedBody = Buffer.from("not json").toString("base64");
      signSet(e);
    });
    expect(statusOf(entry, log)).toBe("invalid");
  });

  it("pins rekor.sigstore.dev, whose log id is its key's hash", () => {
    expect(REKOR_V1.logId).toBe("wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=");
  });
});

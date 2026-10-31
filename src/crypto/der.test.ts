import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DerError, fulcioIdentity, readTlv } from "./der.ts";

// semver@7.7.2's SLSA provenance bundle as npm serves it (fetched 2026-10-31).
const bundle = JSON.parse(
  readFileSync(
    new URL("./fixtures/semver-7.7.2-provenance.json", import.meta.url),
    "utf8",
  ),
);
const cert = Buffer.from(
  bundle.verificationMaterial.certificate.rawBytes,
  "base64",
);

describe("readTlv", () => {
  it("reads short and long lengths", () => {
    expect(readTlv(Buffer.from([0x04, 0x02, 0xaa, 0xbb]), 0)).toEqual({
      tag: 0x04,
      start: 2,
      end: 4,
    });
    const long = Buffer.concat([
      Buffer.from([0x04, 0x81, 0x80]),
      Buffer.alloc(0x80),
    ]);
    expect(readTlv(long, 0)).toEqual({ tag: 0x04, start: 3, end: 0x83 });
  });

  it.each([
    ["a length past the end", [0x04, 0x05, 0x00]],
    ["an indefinite length", [0x30, 0x80, 0x00, 0x00]],
    ["a truncated header", [0x04]],
    ["a length of more than four bytes", [0x04, 0x85, 1, 1, 1, 1, 1]],
    ["a non-minimal long length", [0x04, 0x81, 0x05, 0, 0, 0, 0, 0]],
    ["a high tag number", [0x1f, 0x81, 0x01, 0x00]],
  ])("rejects %s", (_what, bytes) => {
    expect(() => readTlv(Buffer.from(bytes), 0)).toThrow(DerError);
  });
});

describe("fulcioIdentity", () => {
  it("reads the build identity of a real npm provenance certificate", () => {
    expect(fulcioIdentity(cert)).toEqual({
      issuer: "https://token.actions.githubusercontent.com",
      buildSignerUri:
        "https://github.com/npm/node-semver/.github/workflows/release-integration.yml@refs/heads/main",
      runnerEnvironment: "github-hosted",
      sourceRepositoryUri: "https://github.com/npm/node-semver",
      sourceRepositoryDigest: "281055e7716ef0415a8826972471331989ede58c",
      sourceRepositoryRef: "refs/heads/main",
      sourceRepositoryId: "1357199",
      buildConfigUri:
        "https://github.com/npm/node-semver/.github/workflows/release.yml@refs/heads/main",
    });
  });

  it("rejects a certificate cut short", () => {
    expect(() => fulcioIdentity(cert.subarray(0, 900))).toThrow(DerError);
  });

  it("rejects bytes that are not a certificate", () => {
    expect(() => fulcioIdentity(Buffer.from("not a certificate"))).toThrow(
      DerError,
    );
  });

  it("rejects a certificate that states an identity extension twice", () => {
    // Re-encode the issuer extension (OID 1.3.6.1.4.1.57264.1.8) under the
    // OID of the runner extension (…1.11), which the certificate also has.
    const issuerOid = Buffer.from(
      "06 0a 2b 06 01 04 01 83 bf 30 01 08".replaceAll(" ", ""),
      "hex",
    );
    const runnerOid = Buffer.from("060a2b0601040183bf30010b", "hex");
    const at = cert.indexOf(issuerOid);
    expect(at).toBeGreaterThan(0);
    const twice = Buffer.from(cert);
    runnerOid.copy(twice, at);
    expect(() => fulcioIdentity(twice)).toThrow(/twice/);
  });

  describe("a hand-built extension", () => {
    // Just the path fulcioIdentity walks: certificate > tbs > [3] > extensions.
    const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
      const body = Buffer.concat(parts);
      return Buffer.concat([Buffer.from([tag, body.length]), body]);
    };
    const issuerOid = Buffer.from("2b0601040183bf300108", "hex");
    const certWith = (value: Buffer): Buffer =>
      tlv(
        0x30,
        tlv(
          0x30,
          tlv(
            0xa3,
            tlv(0x30, tlv(0x30, tlv(0x06, issuerOid), tlv(0x04, value))),
          ),
        ),
      );
    const issuer = tlv(0x0c, Buffer.from("https://issuer.example"));

    it("reads its string", () => {
      expect(fulcioIdentity(certWith(issuer)).issuer).toBe(
        "https://issuer.example",
      );
    });

    it("rejects bytes after its string", () => {
      expect(() =>
        fulcioIdentity(certWith(Buffer.concat([issuer, Buffer.from([0])]))),
      ).toThrow(/trailing/);
    });
  });
});

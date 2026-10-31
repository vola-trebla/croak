/**
 * Just enough DER to read the build identity Fulcio writes into a signing
 * certificate (M7, D42). node:crypto verifies certificates but does not expose
 * custom extensions. Certificates come from the registry, so every length is
 * checked against the bytes that are there.
 */

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerError";
  }
}

/** One DER element: its tag byte and where its contents start and end. */
export interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}

export function readTlv(buf: Buffer, offset: number): Tlv {
  const tag = buf[offset];
  const first = buf[offset + 1];
  if (tag === undefined || first === undefined)
    throw new DerError(`truncated element at byte ${offset}`);
  if ((tag & 0x1f) === 0x1f)
    throw new DerError(`high tag numbers are not supported (byte ${offset})`);
  let length = first;
  let start = offset + 2;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0) throw new DerError("indefinite length is not DER");
    if (count > 4) throw new DerError(`length of ${count} bytes is too long`);
    length = 0;
    for (let i = 0; i < count; i++) {
      const byte = buf[start + i];
      if (byte === undefined) throw new DerError("truncated length");
      length = length * 256 + byte;
    }
    if (length < 0x80 || (count > 1 && length < 256 ** (count - 1)))
      throw new DerError("length is not in its shortest form");
    start += count;
  }
  const end = start + length;
  if (end > buf.length)
    throw new DerError(`element at byte ${offset} runs past the end`);
  return { tag, start, end };
}

/** The elements inside a constructed element, in order. */
export function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end; ) {
    const child = readTlv(buf, at);
    if (child.end > parent.end)
      throw new DerError(`element at byte ${at} runs past its parent`);
    out.push(child);
    at = child.end;
  }
  return out;
}

function expectTag(tlv: Tlv | undefined, tag: number, what: string): Tlv {
  if (tlv === undefined || tlv.tag !== tag)
    throw new DerError(`expected ${what}`);
  return tlv;
}

function oidOf(buf: Buffer, tlv: Tlv): string {
  const bytes = buf.subarray(tlv.start, tlv.end);
  const first = bytes[0];
  if (first === undefined) throw new DerError("empty OID");
  // The first byte packs the first two arcs as 40 * a + b (a is at most 2).
  const top = Math.min(2, Math.floor(first / 40));
  const arcs = [top, first - top * 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER)
      throw new DerError("OID arc too large");
    if (!(byte & 0x80)) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join(".");
}

/** Who built a package, as Fulcio certified it from the CI's OIDC token. */
export interface BuildIdentity {
  readonly issuer: string | undefined;
  /** The workflow that signed: a reusable workflow, or the build config itself. */
  readonly buildSignerUri: string | undefined;
  /** github-hosted or self-hosted. */
  readonly runnerEnvironment: string | undefined;
  readonly sourceRepositoryUri: string | undefined;
  /** The commit the build ran on. */
  readonly sourceRepositoryDigest: string | undefined;
  readonly sourceRepositoryRef: string | undefined;
  /** The repository's numeric id: survives renames, changes when a name is re-registered. */
  readonly sourceRepositoryId: string | undefined;
  /** The workflow file the run started from, at its ref. */
  readonly buildConfigUri: string | undefined;
}

// Fulcio's v2 extensions (1.3.6.1.4.1.57264.1.8 onwards), each a DER UTF8String.
const FULCIO = "1.3.6.1.4.1.57264.1.";
const FIELDS: Readonly<Record<string, keyof BuildIdentity>> = {
  [`${FULCIO}8`]: "issuer",
  [`${FULCIO}9`]: "buildSignerUri",
  [`${FULCIO}11`]: "runnerEnvironment",
  [`${FULCIO}12`]: "sourceRepositoryUri",
  [`${FULCIO}13`]: "sourceRepositoryDigest",
  [`${FULCIO}14`]: "sourceRepositoryRef",
  [`${FULCIO}15`]: "sourceRepositoryId",
  [`${FULCIO}18`]: "buildConfigUri",
};

const UTF8_STRING = 0x0c;
const OCTET_STRING = 0x04;
const SEQUENCE = 0x30;
const OID = 0x06;
const EXTENSIONS = 0xa3;

/**
 * The build identity in a Fulcio certificate. Reads only; whether the
 * certificate is genuine is src/crypto/sigstore.ts's job.
 */
export function fulcioIdentity(certDer: Buffer): BuildIdentity {
  const cert = expectTag(readTlv(certDer, 0), SEQUENCE, "a certificate");
  const tbs = expectTag(children(certDer, cert)[0], SEQUENCE, "tbsCertificate");
  const wrapper = children(certDer, tbs).find((t) => t.tag === EXTENSIONS);
  const identity: Record<string, string> = {};
  if (wrapper !== undefined) {
    const list = expectTag(
      children(certDer, wrapper)[0],
      SEQUENCE,
      "extensions",
    );
    const seen = new Set<string>();
    for (const ext of children(certDer, list)) {
      const parts = children(certDer, expectTag(ext, SEQUENCE, "an extension"));
      const oid = oidOf(certDer, expectTag(parts[0], OID, "an extension OID"));
      if (seen.has(oid)) throw new DerError(`extension ${oid} appears twice`);
      seen.add(oid);
      const field = FIELDS[oid];
      if (field === undefined) continue;
      const octets = expectTag(
        parts.at(-1),
        OCTET_STRING,
        "an extension value",
      );
      const text = expectTag(
        readTlv(certDer, octets.start),
        UTF8_STRING,
        `a string in ${oid}`,
      );
      if (text.end !== octets.end)
        throw new DerError(`trailing bytes in ${oid}`);
      identity[field] = certDer.subarray(text.start, text.end).toString("utf8");
    }
  }
  return {
    issuer: identity.issuer,
    buildSignerUri: identity.buildSignerUri,
    runnerEnvironment: identity.runnerEnvironment,
    sourceRepositoryUri: identity.sourceRepositoryUri,
    sourceRepositoryDigest: identity.sourceRepositoryDigest,
    sourceRepositoryRef: identity.sourceRepositoryRef,
    sourceRepositoryId: identity.sourceRepositoryId,
    buildConfigUri: identity.buildConfigUri,
  };
}

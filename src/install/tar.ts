import { gunzipSync } from "node:zlib";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";

/**
 * Reads an npm package tarball (gzip + ustar, with pax and GNU long names)
 * entirely in memory and exposes it as a RepoSnapshot, so the repo detectors
 * run on package contents unchanged. Nothing is ever written to disk, so `../`
 * paths and link entries cannot escape anywhere; they are recorded as data.
 * The archive is hostile input: every resource is bounded (D27).
 */

export interface TarLimits {
  /** Decompressed size: the decompression-bomb limit. */
  readonly maxUnpackedBytes: number;
  readonly maxEntries: number;
  /** Larger files are recorded as oversized and never read. */
  readonly maxFileBytes: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxUnpackedBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  // Bundles of a few MB are common in packages; reading them is cheap in memory.
  maxFileBytes: 8 * 1024 * 1024,
};

export class TarballError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarballError";
  }
}

const BLOCK = 512;

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function octal(block: Buffer, start: number, length: number): number {
  const raw = text(block, start, length).trim();
  if (!/^[0-7]*$/.test(raw))
    throw new TarballError(`invalid number field: ${JSON.stringify(raw)}`);
  return raw === "" ? 0 : Number.parseInt(raw, 8);
}

function verifyChecksum(block: Buffer): void {
  const expected = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++)
    sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  if (sum !== expected)
    throw new TarballError(
      "header checksum mismatch: corrupted or crafted archive",
    );
}

/** pax records: "<len> key=value\n" … */
function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(
      data.subarray(offset, space).toString("ascii"),
      10,
    );
    if (
      !Number.isFinite(length) ||
      length <= 0 ||
      offset + length > data.length
    )
      break;
    const record = data
      .subarray(space + 1, offset + length - 1)
      .toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path")
      path = record.slice(eq + 1);
    offset += length;
  }
  return path;
}

/** Drop the archive's top-level directory (`package/` in npm tarballs). */
function relative(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function snapshotTarball(
  gzipped: Buffer,
  limits: Partial<TarLimits> = {},
): RepoSnapshot {
  const { maxUnpackedBytes, maxEntries, maxFileBytes } = {
    ...DEFAULT_TAR_LIMITS,
    ...limits,
  };
  let tar: Buffer;
  try {
    tar = gunzipSync(gzipped, { maxOutputLength: maxUnpackedBytes });
  } catch (error) {
    if (error instanceof RangeError)
      throw new TarballError(`unpacked size exceeds ${maxUnpackedBytes} bytes`);
    throw new TarballError(
      `not a gzip archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries: RepoEntry[] = [];
  const contents = new Map<string, { start: number; size: number }>();
  let headers = 0;
  let pendingName: string | undefined;
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break; // end-of-archive marker
    headers += 1;
    if (headers > maxEntries)
      throw new TarballError(`more than ${maxEntries} entries`);
    verifyChecksum(block);

    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length)
      throw new TarballError(
        "archive is truncated: an entry runs past the end",
      );
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      pendingName = paxPath(data) ?? pendingName;
      continue;
    }
    if (type === "L") {
      pendingName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "g") continue; // global pax header

    const prefix = text(block, 345, 155);
    const headerName = text(block, 0, 100);
    const name =
      pendingName ?? (prefix === "" ? headerName : `${prefix}/${headerName}`);
    pendingName = undefined;
    const path = relative(name);
    if (path === "" || type === "5") continue; // directories

    if (type === "1" || type === "2") {
      entries.push({ path, kind: "symlink", size: 0 });
    } else if (type === "0" || type === "\0" || type === "7") {
      entries.push({
        path,
        kind: size > maxFileBytes ? "oversized" : "file",
        size,
      });
      if (size <= maxFileBytes) contents.set(path, { start: dataStart, size });
    }
    // Other types (devices, FIFOs) carry no code and are ignored.
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    entries,
    read(path) {
      const at = contents.get(path);
      return at === undefined
        ? undefined
        : tar.toString("utf8", at.start, at.start + at.size);
    },
  };
}

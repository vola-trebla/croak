import { posix } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";

/**
 * Reads an npm package tarball (gzip + ustar, with pax and GNU long names)
 * entirely in memory and exposes it as a RepoSnapshot, so the repo detectors
 * run on package contents unchanged. Nothing is ever written to disk.
 * The archive is hostile input: every resource is bounded (D27), and it must
 * read the way npm's tar (node-tar) reads it — a file croak sees differently
 * from what npm installs is a bypass. Where the two could disagree (one zero
 * block, a pax size, unknown entry types, duplicate or `../` paths) the
 * archive is rejected instead of read one way.
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
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
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
      throw new TarballError("malformed pax header");
    const record = data
      .subarray(space + 1, offset + length - 1)
      .toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1) records.set(record.slice(0, eq), record.slice(eq + 1));
    offset += length;
  }
  return records;
}

/** POSIX ustar ("ustar\0" + "00"): only then does node-tar read the name prefix. */
const isUstar = (block: Buffer): boolean =>
  block.toString("latin1", 257, 265) === "ustar\u000000";

/** Drop the archive's top-level directory (`package/` in npm tarballs), as npm does. */
function relative(path: string): string {
  const slash = path.indexOf("/");
  const rest = slash === -1 ? "" : path.slice(slash + 1);
  if (rest === "") return "";
  const normalized = posix.normalize(rest).replace(/\/+$/, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  )
    throw new TarballError(`entry escapes the package: ${path}`);
  return normalized === "." ? "" : normalized;
}

const FILE_TYPES = new Set(["0", "\0", "7"]);
const LINK_TYPES = new Set(["1", "2"]);
/** Devices, FIFOs and directories carry no code. */
const IGNORED_TYPES = new Set(["3", "4", "5", "6"]);

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
  const seen = new Set<string>();
  let headers = 0;
  let pendingName: string | undefined;
  let pendingSize: number | undefined;
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) {
      // node-tar ends the archive only at two zero blocks in a row; a single
      // one followed by more entries would hide them from croak alone.
      const next = tar.subarray(offset + BLOCK, offset + 2 * BLOCK);
      if (next.length === BLOCK && !next.every((byte) => byte === 0))
        throw new TarballError(
          "a zero block in the middle of the archive: entries after it would be hidden",
        );
      break;
    }
    headers += 1;
    if (headers > maxEntries)
      throw new TarballError(`more than ${maxEntries} entries`);
    verifyChecksum(block);

    const type = String.fromCharCode(block[156] ?? 0);
    const size = pendingSize ?? octal(block, 124, 12);
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length)
      throw new TarballError(
        "archive is truncated: an entry runs past the end",
      );
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x" || type === "X") {
      const records = paxRecords(data);
      pendingName = records.get("path") ?? pendingName;
      const paxSize = records.get("size");
      if (paxSize !== undefined) {
        if (!/^\d{1,15}$/.test(paxSize))
          throw new TarballError(`invalid pax size: ${paxSize}`);
        pendingSize = Number(paxSize);
      }
      continue;
    }
    if (type === "L" || type === "N") {
      pendingName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "K") continue; // long link target: not a name
    if (type === "g") {
      const records = paxRecords(data);
      if (records.has("path") || records.has("size"))
        throw new TarballError(
          "a global pax header sets path or size for later entries",
        );
      continue;
    }

    const prefix = isUstar(block) ? text(block, 345, 155) : "";
    const headerName = text(block, 0, 100);
    const name =
      pendingName ?? (prefix === "" ? headerName : `${prefix}/${headerName}`);
    pendingName = undefined;
    pendingSize = undefined;
    const path = relative(name);

    if (IGNORED_TYPES.has(type) || path === "") continue;
    if (!FILE_TYPES.has(type) && !LINK_TYPES.has(type))
      throw new TarballError(
        `unknown entry type ${JSON.stringify(type)} for ${name}`,
      );
    if (seen.has(path))
      throw new TarballError(
        `${path} appears twice: npm installs the last copy`,
      );
    seen.add(path);
    if (LINK_TYPES.has(type)) {
      entries.push({ path, kind: "symlink", size: 0 });
    } else {
      entries.push({
        path,
        kind: size > maxFileBytes ? "oversized" : "file",
        size,
      });
      if (size <= maxFileBytes) contents.set(path, { start: dataStart, size });
    }
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

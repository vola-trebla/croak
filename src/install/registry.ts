import { createHash } from "node:crypto";
/**
 * A minimal npm registry client: one packument per package, read with a time
 * limit and a size limit. Package names come from untrusted lockfiles, so they
 * are validated against npm's naming rules before they become a URL.
 */

export const REGISTRY = "https://registry.npmjs.org";
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
// Legacy packages may contain capitals (JSONStream); new ones may not.
const NAME =
  /^(?:@[a-zA-Z0-9-~][a-zA-Z0-9-._~]*\/)?[a-zA-Z0-9-~][a-zA-Z0-9-._~]*$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
const SRI_ALGORITHMS = ["sha512", "sha384", "sha256", "sha1"] as const;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface FetchOptions {
  readonly fetch?: typeof fetch;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export function packageUrl(name: string): string {
  if (name.length > 214 || !NAME.test(name) || name.includes("..")) {
    throw new RegistryError(
      `not a valid npm package name: ${JSON.stringify(name)}`,
    );
  }
  return `${REGISTRY}/${name.startsWith("@") ? name.replace("/", "%2F") : name}`;
}

async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (reader === undefined) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RegistryError(`response too large (over ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return (await readCappedBytes(response, maxBytes)).toString("utf8");
}

/** The package document, or "not-found" when the registry has no such package. */
export async function fetchPackument(
  name: string,
  options: FetchOptions = {},
): Promise<unknown> {
  const url = packageUrl(name);
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RegistryError(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404) return "not-found";
  if (!response.ok)
    throw new RegistryError(`${name}: registry answered ${response.status}`);
  const text = await readCapped(
    response,
    options.maxBytes ?? DEFAULT_MAX_BYTES,
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new RegistryError(`${name}: registry response is not JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const date = (value: unknown): Date | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export interface EarlierVersion {
  readonly version: string;
  readonly hasProvenance: boolean;
  readonly publisher: string | undefined;
}

export interface VersionFacts {
  readonly created: Date | undefined;
  readonly published: Date | undefined;
  readonly ageDays: number | undefined;
  /** The registry recorded a provenance attestation for this version (not verified here; M7). */
  readonly hasProvenance: boolean;
  readonly publisher: string | undefined;
  /** Versions published before this one, newest first (at most 10). */
  readonly earlier: readonly EarlierVersion[];
}

function versionInfo(meta: unknown): {
  hasProvenance: boolean;
  publisher: string | undefined;
} {
  const dist = isRecord(meta) && isRecord(meta.dist) ? meta.dist : {};
  const user = isRecord(meta) && isRecord(meta._npmUser) ? meta._npmUser : {};
  return {
    hasProvenance:
      isRecord(dist.attestations) && dist.attestations.provenance !== undefined,
    publisher: typeof user.name === "string" ? user.name : undefined,
  };
}

/** What the registry says about one version, or undefined if it does not list it. */
export function versionFacts(
  packument: unknown,
  version: string,
  now: Date = new Date(),
): VersionFacts | undefined {
  if (
    !isRecord(packument) ||
    !isRecord(packument.versions) ||
    !(version in packument.versions)
  )
    return undefined;
  const versions = packument.versions;
  const time = isRecord(packument.time) ? packument.time : {};
  const published = date(time[version]);
  const earlier = Object.keys(versions)
    .filter((v) => v !== version)
    .map((v) => ({ v, at: date(time[v]) }))
    .filter(
      (e): e is { v: string; at: Date } =>
        e.at !== undefined && published !== undefined && e.at < published,
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 10)
    .map(({ v }) => ({ version: v, ...versionInfo(versions[v]) }));
  return {
    created: date(time.created),
    published,
    ageDays:
      published === undefined
        ? undefined
        : Math.floor((now.getTime() - published.getTime()) / DAY_MS),
    ...versionInfo(versions[version]),
    earlier,
  };
}

/** The downloaded tarball does not match the lockfile's integrity hash. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** Checks data against an SRI string ("sha512-…"), using the strongest algorithm it lists. */
export function verifyIntegrity(data: Buffer, integrity: string): void {
  const hashes = new Map(
    integrity
      .trim()
      .split(/\s+/)
      .map(
        (token) =>
          [
            token.slice(0, token.indexOf("-")),
            token.slice(token.indexOf("-") + 1),
          ] as const,
      ),
  );
  const algorithm = SRI_ALGORITHMS.find((alg) => hashes.has(alg));
  if (algorithm === undefined)
    throw new IntegrityError(
      `unsupported integrity format: ${integrity.slice(0, 40)}`,
    );
  const actual = createHash(algorithm).update(data).digest("base64");
  if (actual !== hashes.get(algorithm))
    throw new IntegrityError(`${algorithm} does not match the lockfile`);
}

/**
 * Downloads a tarball from the public registry (https only) with a timeout
 * and a 100 MB cap, and verifies it against the lockfile's integrity hash.
 */
export async function fetchTarball(
  url: string,
  integrity: string | undefined,
  options: FetchOptions = {},
): Promise<Buffer> {
  if (!url.startsWith(`${REGISTRY}/`))
    throw new RegistryError(
      `refusing to download a tarball from outside ${REGISTRY}: ${url}`,
    );
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS * 4),
    });
  } catch (error) {
    throw new RegistryError(
      `${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok)
    throw new RegistryError(`${url}: registry answered ${response.status}`);
  const data = await readCappedBytes(
    response,
    options.maxBytes ?? MAX_TARBALL_BYTES,
  );
  if (integrity !== undefined) verifyIntegrity(data, integrity);
  return data;
}

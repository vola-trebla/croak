import { stripBom } from "../signals/text.ts";

/** One installed package in an npm v2/v3 lockfile (`packages` map). */
export interface LockEntry {
  /** Lockfile key, e.g. `node_modules/a/node_modules/b`. */
  readonly path: string;
  readonly name: string;
  readonly version: string | undefined;
  readonly resolved: string | undefined;
  readonly integrity: string | undefined;
  /** npm records this when the package has preinstall/install/postinstall scripts. */
  readonly hasInstallScript: boolean;
  /** A workspace or `file:` link, not a downloaded package. */
  readonly link: boolean;
  readonly dev: boolean;
  readonly optional: boolean;
}

export class LockfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockfileError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** `node_modules/a/node_modules/@s/b` → `@s/b`. */
function nameFromPath(path: string): string {
  const index = path.lastIndexOf("node_modules/");
  return index === -1 ? path : path.slice(index + "node_modules/".length);
}

/** Parses an npm lockfile (v2 or v3). Lockfile v1 has no `packages` map and is rejected. */
export function parseLockfile(text: string): LockEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch (error) {
    throw new LockfileError(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(data) || !isRecord(data.packages)) {
    throw new LockfileError(
      "no packages map: lockfile v1 is not supported, regenerate it with npm 7 or later",
    );
  }
  return Object.entries(data.packages).flatMap(([path, raw]) => {
    if (path === "") return [];
    if (!isRecord(raw))
      throw new LockfileError(`entry ${path} is not an object`);
    return [
      {
        path,
        name: asString(raw.name) ?? nameFromPath(path),
        version: asString(raw.version),
        resolved: asString(raw.resolved),
        integrity: asString(raw.integrity),
        hasInstallScript: raw.hasInstallScript === true,
        link: raw.link === true,
        dev: raw.dev === true,
        optional: raw.optional === true,
      },
    ];
  });
}

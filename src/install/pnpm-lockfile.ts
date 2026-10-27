import type { LockEntry } from "./lockfile.ts";
import { LockfileError } from "./lockfile.ts";
import { REGISTRY } from "./registry.ts";
import { parseYamlDocuments, YamlError } from "./yaml.ts";

/**
 * pnpm-lock.yaml (lockfile v9: pnpm 9 and later, M6, D38) as the same
 * LockEntry list the npm lockfile gives, so the rest of croak plan is shared.
 * Registry packages carry only an integrity hash: the tarball URL is the
 * public registry's, as pnpm itself derives it (the hook refuses other
 * registries, D34). Git and tarball resolutions keep their source, so
 * install/source reports them; local directories are links. pnpm records no
 * hasInstallScript: install scripts come from the registry manifest and the
 * tarball instead.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/** "@scope/name@1.2.3" → ["@scope/name", "1.2.3"]; the version may be a URL or path. */
function splitKey(key: string): [string, string] {
  const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  if (at <= 0) throw new LockfileError(`package key without a version: ${key}`);
  return [key.slice(0, at), key.slice(at + 1)];
}

/** Strip a snapshot's peer suffix: "react-dom@19.2.0(react@19.3.1)" → "react-dom@19.2.0". */
const withoutPeers = (key: string): string => {
  const open = key.indexOf("(");
  return open === -1 ? key : key.slice(0, open);
};

const registryUrl = (name: string, version: string): string =>
  `${REGISTRY}/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;

export function isPnpmLockfile(text: string): boolean {
  return /^(?:---\s*\n)?\s*lockfileVersion:\s*['"]?\d/.test(text);
}

export function parsePnpmLockfile(text: string): LockEntry[] {
  let docs: unknown[];
  try {
    docs = parseYamlDocuments(text);
  } catch (error) {
    if (error instanceof YamlError)
      throw new LockfileError(`pnpm-lock.yaml: ${error.message}`);
    throw error;
  }
  const entries: LockEntry[] = [];
  for (const doc of docs) {
    if (!isRecord(doc))
      throw new LockfileError("pnpm-lock.yaml: a document is not a mapping");
    const version = doc.lockfileVersion;
    if (typeof version !== "string" || !/^9\.\d+$/.test(version))
      throw new LockfileError(
        `pnpm-lock.yaml version ${String(version)} is not supported: croak reads lockfile v9 (pnpm 9 and later)`,
      );
    const packages = isRecord(doc.packages) ? doc.packages : {};
    const snapshots = isRecord(doc.snapshots) ? doc.snapshots : {};
    // A package is optional only when every snapshot of it is.
    const optional = new Map<string, boolean>();
    for (const [key, snap] of Object.entries(snapshots)) {
      const id = withoutPeers(key);
      const isOptional = isRecord(snap) && snap.optional === "true";
      optional.set(id, (optional.get(id) ?? true) && isOptional);
    }
    for (const [key, raw] of Object.entries(packages)) {
      if (!isRecord(raw))
        throw new LockfileError(
          `pnpm-lock.yaml: package ${key} is not a mapping`,
        );
      const [name, ref] = splitKey(key);
      const resolution = isRecord(raw.resolution) ? raw.resolution : {};
      const integrity =
        typeof resolution.integrity === "string"
          ? resolution.integrity
          : undefined;
      let resolved: string | undefined;
      let link = false;
      if (typeof resolution.directory === "string") link = true;
      else if (resolution.type === "git" && typeof resolution.repo === "string")
        resolved = `git+${resolution.repo}#${typeof resolution.commit === "string" ? resolution.commit : ""}`;
      else if (typeof resolution.tarball === "string")
        resolved = resolution.tarball;
      else if (integrity !== undefined) resolved = registryUrl(name, ref);
      // A git or tarball dependency's "version" is its source, not a semver.
      const semver = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(ref);
      entries.push({
        path: `pnpm:${key}`,
        name,
        version: semver
          ? ref
          : typeof raw.version === "string"
            ? raw.version
            : ref,
        resolved,
        integrity,
        hasInstallScript: raw.requiresBuild === "true",
        link,
        dev: false,
        optional: optional.get(key) ?? false,
        os: strings(raw.os),
        cpu: strings(raw.cpu),
      });
    }
  }
  return entries;
}

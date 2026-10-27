import { stripBom } from "../signals/text.ts";
import { parseYamlDocuments } from "./yaml.ts";

/**
 * What the planning wrapper may hand to a package manager from an untrusted
 * project (M6, D38). Planning must run no project code, but pnpm runs code
 * before it resolves anything: corepack downloads and runs the pnpm version a
 * project's `packageManager` names (checked: pnpm 12 ran pnpm 9.15.0, even
 * with manage-package-manager-versions=false), and pnpm-workspace.yaml can
 * load pnpmfiles and config dependencies. So the root manifest loses its
 * package-manager pins, and the workspace file keeps only settings that shape
 * resolution. Both come out as JSON, which YAML reads too.
 */

export class SanitizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SanitizeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The root package.json without the fields that make corepack fetch a package manager. */
export function sanitizeRootManifest(text: string): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(stripBom(text));
  } catch {
    throw new SanitizeError("package.json is not valid JSON");
  }
  if (!isRecord(manifest))
    throw new SanitizeError("package.json is not an object");
  const { packageManager: _pm, devEngines: _de, pnpm, ...rest } = manifest;
  // pnpm 10 reads settings from the root manifest's "pnpm" field too.
  const kept = isRecord(pnpm)
    ? {
        ...rest,
        pnpm: Object.fromEntries(
          Object.entries(pnpm).filter(([key]) => WORKSPACE_KEYS.has(key)),
        ),
      }
    : rest;
  return `${JSON.stringify(kept, null, 2)}\n`;
}

/** Settings that only shape what pnpm resolves; nothing that loads or runs code, or moves the registry. */
const WORKSPACE_KEYS = new Set([
  "packages",
  "catalog",
  "catalogs",
  "overrides",
  "packageExtensions",
  "peerDependencyRules",
  "autoInstallPeers",
  "dedupePeerDependents",
  "excludeLinksFromLockfile",
  "resolutionMode",
  "linkWorkspacePackages",
  "injectWorkspacePackages",
  "sharedWorkspaceLockfile",
  "supportedArchitectures",
  "ignoredOptionalDependencies",
]);

/** YAML scalars come back as strings; pnpm wants booleans where YAML had them. */
function typed(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (Array.isArray(value)) return value.map(typed);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, typed(v)]),
    );
  return value;
}

export function sanitizePnpmWorkspace(text: string): string {
  let docs: unknown[];
  try {
    docs = parseYamlDocuments(text);
  } catch (error) {
    throw new SanitizeError(
      `pnpm-workspace.yaml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (docs.length > 1)
    throw new SanitizeError("pnpm-workspace.yaml has more than one document");
  const doc = docs[0] ?? {};
  if (!isRecord(doc))
    throw new SanitizeError("pnpm-workspace.yaml is not a mapping");
  const kept = Object.fromEntries(
    Object.entries(doc).filter(([key]) => WORKSPACE_KEYS.has(key)),
  );
  return `${JSON.stringify(typed(kept), null, 2)}\n`;
}

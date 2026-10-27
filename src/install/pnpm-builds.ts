import { labelOf } from "../llm/select.ts";
import { stripBom } from "../signals/text.ts";
import type { Finding } from "../verdict.ts";
import { parseYamlDocuments, YamlError } from "./yaml.ts";

/**
 * pnpm 10 and later do not run a dependency's install scripts unless the
 * project allows them (M6, D38): `allowBuilds` (pnpm 10.26+, the only form in
 * pnpm 11), `onlyBuiltDependencies` (pnpm 10), `permissions`, or
 * `dangerouslyAllowAllBuilds`. croak reads them conservatively: a package
 * counts as "pnpm will not run its scripts" only when nothing names it at
 * all, the pnpm version is 10 or later, nothing allows every build, and both
 * files read cleanly. Any doubt leaves the warning as it is.
 */

/** True when pnpm may run this package's install scripts. */
export type BuildPolicy = (name: string) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "nx@21.6.4 || 21.6.5" → "nx"; "@s/x@1" → "@s/x". */
const matcherName = (key: string): string => {
  const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return (at === -1 ? key : key.slice(0, at)).trim();
};

export function pnpmBuildPolicy(
  files: {
    readonly packageJson: string | undefined;
    readonly workspaceYaml: string | undefined;
  },
  pnpmVersion: string,
): BuildPolicy | undefined {
  const major = Number(/^(\d+)\./.exec(pnpmVersion)?.[1] ?? Number.NaN);
  if (!(major >= 10)) return undefined;
  const settings: Record<string, unknown>[] = [];
  try {
    if (files.packageJson !== undefined) {
      const manifest: unknown = JSON.parse(stripBom(files.packageJson));
      if (isRecord(manifest) && isRecord(manifest.pnpm))
        settings.push(manifest.pnpm);
    }
    if (files.workspaceYaml !== undefined)
      for (const doc of parseYamlDocuments(files.workspaceYaml))
        if (isRecord(doc)) settings.push(doc);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof YamlError)
      return undefined;
    throw error;
  }
  const named = new Set<string>();
  for (const s of settings) {
    if (
      s.dangerouslyAllowAllBuilds === true ||
      s.dangerouslyAllowAllBuilds === "true"
    )
      return undefined;
    // A list in a file croak does not read: it could allow anything.
    if (s.onlyBuiltDependenciesFile !== undefined) return undefined;
    for (const field of [
      "onlyBuiltDependencies",
      "neverBuiltDependencies",
      "ignoredBuiltDependencies",
    ]) {
      const list = s[field];
      if (Array.isArray(list))
        for (const item of list) if (typeof item === "string") named.add(item);
    }
    for (const field of ["allowBuilds", "permissions"])
      if (isRecord(s[field]))
        for (const key of Object.keys(s[field])) named.add(matcherName(key));
  }
  // A glob or pattern croak does not expand could name anything.
  if ([...named].some((name) => /[*?{}[\]!]/.test(name))) return undefined;
  return (name) => named.has(name);
}

const SCRIPT_RULES = new Set([
  "repo/lifecycle-script",
  "install/install-script",
  "install/new-install-script",
]);

/**
 * Warnings about install scripts pnpm will not run become info. Blocks stay:
 * a malicious script is evidence about the package, and a later
 * `pnpm approve-builds` would run it.
 */
export function applyBuildPolicy(
  findings: readonly Finding[],
  policy: BuildPolicy,
): Finding[] {
  return findings.map((f) => {
    const label = labelOf(f.file);
    if (
      label === undefined ||
      f.severity !== "warn" ||
      !SCRIPT_RULES.has(f.ruleId)
    )
      return f;
    const name = label.slice(0, label.lastIndexOf("@"));
    return policy(name)
      ? f
      : {
          ...f,
          severity: "info",
          message: `${f.message} (pnpm will not run it: the project does not allow builds for ${name})`,
        };
  });
}

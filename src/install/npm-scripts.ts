import { stripBom } from "../signals/text.ts";
import { type BuildPolicy, matcherName } from "./pnpm-builds.ts";

/**
 * npm 12 and later do not run a dependency's install scripts unless they are
 * allowed (D56): `allowScripts` in the project's package.json (`"name"` or
 * `"name@version"`, true or false), npm's `allow-scripts` config, or
 * `dangerously-allow-all-scripts`. Read conservatively, like pnpm's rule
 * (D38): a package counts as "npm will not run its scripts" only when npm is
 * 12 or later, nothing allows every script, package.json reads cleanly, and
 * nothing allows that name in any version. Any doubt changes nothing.
 */

/** npm's own settings, as `npm config get` reports them for the project. */
export interface NpmScriptConfig {
  /** `allow-scripts`: names, possibly `name@version`. */
  readonly allowScripts: readonly string[];
  /** `dangerously-allow-all-scripts`. */
  readonly allowAll: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the manifest pins an npm other than exactly this version. */
function pinnedElsewhere(
  manifest: Record<string, unknown>,
  npmVersion: string,
): boolean {
  const pin = /^npm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(
    String(manifest.packageManager ?? ""),
  );
  if (pin !== null && pin[1] !== npmVersion) return true;
  const engines = manifest.devEngines;
  if (isRecord(engines) && isRecord(engines.packageManager)) {
    const pm = engines.packageManager;
    if (pm.name === "npm" && String(pm.version ?? "") !== npmVersion)
      return true;
  }
  return false;
}

const PATTERN = /[*?{}[\]!]/;

export function npmScriptPolicy(
  packageJson: string | undefined,
  npmVersion: string,
  config: NpmScriptConfig,
): BuildPolicy | undefined {
  const major = Number(/^(\d+)\./.exec(npmVersion)?.[1] ?? Number.NaN);
  if (!(major >= 12) || config.allowAll) return undefined;
  const allowed = new Set(config.allowScripts.map(matcherName));
  if (packageJson !== undefined) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(stripBom(packageJson));
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
    if (!isRecord(manifest) || pinnedElsewhere(manifest, npmVersion))
      return undefined;
    const rules = manifest.allowScripts;
    if (rules !== undefined) {
      if (!isRecord(rules)) return undefined;
      for (const [key, value] of Object.entries(rules)) {
        if (typeof value !== "boolean") return undefined;
        if (value) allowed.add(matcherName(key));
      }
    }
  }
  if ([...allowed].some((name) => PATTERN.test(name) || name === ""))
    return undefined;
  return (name) => allowed.has(name);
}

import type { Finding } from "../verdict.ts";
import type { PlanChange } from "./plan.ts";

/** A check over the packages an install would bring in. */
export type InstallDetector = (
  changes: readonly PlanChange[],
) => readonly Finding[];

const REGISTRY_HOST = "registry.npmjs.org";

const label = (change: PlanChange): string =>
  `${change.entry.name}@${change.entry.version ?? "?"}`;
const what = (change: PlanChange): string =>
  change.kind === "changed"
    ? `updates ${change.entry.name} ${change.previousVersion} → ${change.entry.version}`
    : "is new";

/** npm records hasInstallScript for packages with preinstall/install/postinstall (or binding.gyp). */
export const installScripts: InstallDetector = (changes) =>
  changes
    .filter((c) => c.entry.hasInstallScript)
    .map((c) => ({
      ruleId: "install/install-script",
      severity: "warn",
      file: label(c),
      message: `${what(c)} and runs code at install time (preinstall/install/postinstall or a native build)`,
    }));

function sourceProblem(resolved: string | undefined): string | undefined {
  if (resolved === undefined) return "has no resolved source in the lockfile";
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/.test(resolved))
    return "comes from git, not the npm registry";
  if (resolved.startsWith("file:"))
    return "comes from a local path, not the npm registry";
  try {
    const url = new URL(resolved);
    if (url.protocol !== "https:")
      return `is downloaded over ${url.protocol.replace(":", "")}, not https`;
    if (url.hostname !== REGISTRY_HOST)
      return `comes from ${url.hostname}, not ${REGISTRY_HOST}`;
  } catch {
    // Not a URL at all: neither the registry nor a recognized source.
    return `has an unrecognized source: ${resolved}`;
  }
  return undefined;
}

/** Packages that do not come from the public npm registry over https. */
export const source: InstallDetector = (changes) =>
  changes.flatMap((c): Finding[] => {
    if (c.entry.link) {
      return [
        {
          ruleId: "install/source",
          severity: "info",
          file: label(c),
          message: "is a workspace link, not a download",
        },
      ];
    }
    const problem = sourceProblem(c.entry.resolved);
    return problem === undefined
      ? []
      : [
          {
            ruleId: "install/source",
            severity: "warn",
            file: label(c),
            message: `${what(c)} and ${problem}`,
          },
        ];
  });

/** A downloaded package without an integrity hash is not verified by npm. */
export const integrity: InstallDetector = (changes) =>
  changes
    .filter(
      (c) =>
        !c.entry.link &&
        c.entry.resolved !== undefined &&
        c.entry.integrity === undefined,
    )
    .map((c) => ({
      ruleId: "install/integrity",
      severity: "warn",
      file: label(c),
      message: `${what(c)} and has no integrity hash, so npm does not verify the download`,
    }));

export const installDetectors: readonly InstallDetector[] = [
  installScripts,
  source,
  integrity,
];

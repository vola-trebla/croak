import type { Finding, Severity } from "../verdict.ts";
import type { PlanChange } from "./plan.ts";
import { POPULAR_PACKAGES } from "./popular.ts";
import type { VersionFacts } from "./registry.ts";

const POPULAR = new Set(POPULAR_PACKAGES);
const RECENT_DAYS = 7;
const NEW_PACKAGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const normalize = (name: string): string =>
  name.toLowerCase().replace(/[-_.]/g, "");

/** Optimal string alignment distance (Levenshtein plus adjacent transpositions), capped at 2. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 0; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((d[i - 2] as number[])[j - 2] ?? 0) + 1);
      }
      row[j] = best;
    }
  }
  return Math.min((d[a.length] as number[])[b.length] ?? 2, 2);
}

/** The popular package this unscoped name is one keystroke (or one separator) away from. */
export function nearPopularName(name: string): string | undefined {
  if (name.startsWith("@") || POPULAR.has(name) || name.length < 5)
    return undefined;
  return POPULAR_PACKAGES.find(
    (popular) =>
      popular.length >= 5 &&
      (normalize(popular) === normalize(name) || distance(popular, name) === 1),
  );
}

/**
 * Registry signals for one new or changed version. Each signal alone is a
 * warning (D25), except a new publisher, which alone is context (D28); two
 * patterns block (D26): an install script with dropped
 * provenance or a new publisher (a hijacked maintainer account), and a
 * typo-squat name on a brand-new package.
 */
export function metadataFindings(
  change: PlanChange,
  facts: VersionFacts | "not-found" | undefined,
  now: Date = new Date(),
): Finding[] {
  const { entry } = change;
  const file = `${entry.name}@${entry.version ?? "?"}`;
  const finding = (
    ruleId: string,
    severity: Severity,
    message: string,
  ): Finding => ({ ruleId, severity, file, message });

  if (facts === "not-found")
    return [
      finding(
        "install/registry",
        "warn",
        "is not on the npm registry (unpublished or never published)",
      ),
    ];
  if (facts === undefined)
    return [
      finding(
        "install/registry",
        "warn",
        "is a version the npm registry does not list",
      ),
    ];

  const findings: Finding[] = [];
  const isNewPackage =
    facts.created !== undefined &&
    now.getTime() - facts.created.getTime() < NEW_PACKAGE_DAYS * DAY_MS;
  const recent = facts.earlier.slice(0, 5);
  const provenanceDropped =
    !facts.hasProvenance && recent.some((v) => v.hasProvenance);
  // With provenance, the publisher is a CI identity tied to the source repo;
  // a different account name there is a pipeline change, not a new person.
  const newPublisher =
    !facts.hasProvenance &&
    facts.publisher !== undefined &&
    facts.earlier.length > 0 &&
    !facts.earlier.some((v) => v.publisher === facts.publisher);
  const hijack = entry.hasInstallScript && (provenanceDropped || newPublisher);
  const recentRelease =
    facts.ageDays !== undefined && facts.ageDays < RECENT_DAYS;
  const pattern = hijack
    ? "; with an install script, this is the pattern of a hijacked maintainer account"
    : "";

  if (recentRelease) {
    findings.push(
      finding(
        "install/recent-release",
        "warn",
        `was published ${facts.ageDays} day(s) ago; new versions of popular packages are where hijacks land first`,
      ),
    );
  }
  if (provenanceDropped) {
    findings.push(
      finding(
        "install/provenance",
        hijack ? "block" : "warn",
        `has no provenance, although earlier versions were published with it${pattern}`,
      ),
    );
  }
  if (newPublisher) {
    findings.push(
      finding(
        "install/publisher",
        // Alone it is context: maintainers rotate and orgs publish from
        // service accounts (microsoft1es, GitHub Actions).
        hijack ? "block" : "info",
        `was published by ${facts.publisher}, who did not publish the earlier versions${pattern}`,
      ),
    );
  }
  const lookalike = nearPopularName(entry.name);
  if (lookalike !== undefined) {
    findings.push(
      finding(
        "install/name",
        isNewPackage ? "block" : "warn",
        `looks like the popular package ${lookalike}${isNewPackage ? ", and the package is brand new: a typo-squat or a hallucinated name" : "; check the name"}`,
      ),
    );
  }
  const previous = facts.earlier[0];
  if (
    previous !== undefined &&
    facts.installScripts.length > 0 &&
    previous.installScripts.length === 0
  ) {
    const risky = recentRelease || provenanceDropped || newPublisher;
    findings.push(
      finding(
        "install/new-install-script",
        risky ? "block" : "warn",
        `adds an install script (${facts.installScripts.join(", ")}) that ${previous.version} did not have${risky ? ", in a release that also shows a registry warning: the pattern of a hijacked release" : ""}`,
      ),
    );
  }
  if (isNewPackage)
    findings.push(
      finding(
        "install/new-package",
        "warn",
        `is a brand-new package (created less than ${NEW_PACKAGE_DAYS} days ago)`,
      ),
    );
  return findings;
}

/**
 * Dependencies this version adds compared with its previous version. A new
 * dependency is context; a new dependency that is itself a brand-new package
 * is how the 2026 axios release smuggled in its payload (D27), so it blocks.
 */
export function addedDependencyFindings(
  change: PlanChange,
  facts: VersionFacts,
  createdByName: ReadonlyMap<string, Date | undefined>,
  now: Date = new Date(),
): Finding[] {
  const previous = facts.earlier[0];
  if (previous === undefined) return [];
  const added = facts.dependencies.filter(
    (name) => !previous.dependencies.includes(name),
  );
  const file = `${change.entry.name}@${change.entry.version ?? "?"}`;
  return added.map((name): Finding => {
    const created = createdByName.get(name);
    const days =
      created === undefined
        ? undefined
        : Math.floor((now.getTime() - created.getTime()) / DAY_MS);
    return days !== undefined && days < NEW_PACKAGE_DAYS
      ? {
          ruleId: "install/new-dependency",
          severity: "block",
          file,
          message: `adds dependency ${name}, a package created ${days} day(s) ago, that ${previous.version} did not have: how hijacked releases smuggle in a payload`,
        }
      : {
          ruleId: "install/new-dependency",
          severity: "info",
          file,
          message: `adds dependency ${name} (not in ${previous.version})`,
        };
  });
}

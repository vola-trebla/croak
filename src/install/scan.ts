import { performance } from "node:perf_hooks";
import { aggregate, type Finding, type Verdict } from "../verdict.ts";
import { contentFindings } from "./content.ts";
import type { ContentCache } from "./content-cache.ts";
import { type InstallDetector, installDetectors } from "./detectors.ts";
import {
  installsOn,
  LockfileError,
  type Platform,
  parseLockfile,
} from "./lockfile.ts";
import { addedDependencyFindings, metadataFindings } from "./metadata.ts";
import { diffLockfiles, type PlanChange } from "./plan.ts";
import {
  fetchPackument,
  fetchTarball,
  IntegrityError,
  RegistryError,
  registryTarball,
  versionFacts,
} from "./registry.ts";
import { snapshotTarball, TarballError } from "./tar.ts";

export type PlanOutcome =
  | {
      readonly status: "complete";
      readonly verdict: Verdict;
      readonly findings: readonly Finding[];
      readonly added: number;
      readonly changed: number;
      readonly durationMs: number;
    }
  | {
      /** A lockfile could not be read. Never treat as clean. */
      readonly status: "incomplete";
      readonly reason: string;
      readonly durationMs: number;
    };

/**
 * Judges what an install would bring in, from the project's lockfile before
 * and the lockfile npm planned (`--package-lock-only --ignore-scripts`).
 * croak itself runs no package manager; it only reads the two files.
 */
export function planInstall(
  beforeText: string | undefined,
  afterText: string,
  detectors: readonly InstallDetector[] = installDetectors,
): PlanOutcome {
  const started = performance.now();
  const parse = (text: string, which: string) => {
    try {
      return parseLockfile(text);
    } catch (error) {
      if (error instanceof LockfileError)
        throw new LockfileError(`${which} lockfile: ${error.message}`);
      throw error;
    }
  };
  try {
    const before =
      beforeText === undefined ? undefined : parse(beforeText, "before");
    const changes = diffLockfiles(before, parse(afterText, "after"));
    const findings = detectors.flatMap((detect) => detect(changes));
    return {
      status: "complete",
      verdict: aggregate(findings),
      findings,
      added: changes.filter((c) => c.kind === "added").length,
      changed: changes.filter((c) => c.kind === "changed").length,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    if (!(error instanceof LockfileError)) throw error;
    return {
      status: "incomplete",
      reason: error.message,
      durationMs: performance.now() - started,
    };
  }
}

export interface OnlineOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: Date;
  /** Parallel registry requests. */
  readonly concurrency?: number;
  /** Download and inspect package contents (default true). */
  readonly content?: boolean;
  /** Total compressed tarball bytes one plan may download. */
  readonly maxDownloadBytes?: number;
  /** Where npm will install (default: this machine). Platform packages for others are not downloaded. */
  readonly platform?: Platform;
  /** Content findings remembered by tarball hash; registry facts are always fresh. */
  readonly cache?: ContentCache;
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

/** The plan is too large to inspect within the download budget. */
class BudgetError extends Error {}

/** Runs `work` over `items` with at most `limit` in flight. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
  return results;
}

/**
 * planInstall plus npm registry signals (D26) for every new or changed version
 * that comes from the public registry. Any registry failure makes the whole
 * check incomplete: an agent must not proceed on a partial answer.
 */
export async function planInstallOnline(
  beforeText: string | undefined,
  afterText: string,
  options: OnlineOptions = {},
): Promise<PlanOutcome> {
  const started = performance.now();
  const local = planInstall(beforeText, afterText);
  if (local.status === "incomplete") return local;
  const before =
    beforeText === undefined ? undefined : parseLockfile(beforeText);
  const fromRegistry = diffLockfiles(before, parseLockfile(afterText)).filter(
    (c) => !c.entry.link && registryTarball(c.entry.resolved) !== undefined,
  );
  // npm skips platform packages for other systems, so they are not checked.
  const platform = options.platform ?? {
    os: process.platform,
    cpu: process.arch,
  };
  const changes = fromRegistry.filter((c) => installsOn(c.entry, platform));
  const skipped = fromRegistry.length - changes.length;
  const notes: Finding[] =
    skipped === 0
      ? []
      : [
          {
            ruleId: "install/other-platform",
            severity: "info",
            file: "package-lock.json",
            message: `${skipped} package(s) built for other platforms not checked: npm will not install them on ${platform.os}-${platform.cpu}`,
          },
        ];
  const names = [...new Set(changes.map((c) => c.entry.name))];
  try {
    const fetchOptions =
      options.fetch === undefined ? {} : { fetch: options.fetch };
    const docs = await pool(names, options.concurrency ?? 8, (name) =>
      fetchPackument(name, fetchOptions),
    );
    const byName = new Map(names.map((name, i) => [name, docs[i]]));
    const now = options.now ?? new Date();
    const created = new Map<string, Date | undefined>();
    for (const [name, doc] of byName) {
      if (doc !== "not-found")
        created.set(name, versionFacts(doc, firstVersion(doc), now)?.created);
    }
    const remote = changes.flatMap((c) => {
      const doc = byName.get(c.entry.name);
      const facts =
        doc === "not-found"
          ? "not-found"
          : versionFacts(doc, c.entry.version ?? "", now);
      const deps =
        facts === undefined || facts === "not-found"
          ? []
          : addedDependencyFindings(c, facts, created, now);
      return [...metadataFindings(c, facts, now), ...deps];
    });
    const content =
      options.content === false ? [] : await contentOf(changes, options);
    const findings = [...local.findings, ...notes, ...remote, ...content];
    return {
      ...local,
      verdict: aggregate(findings),
      findings,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    if (error instanceof RegistryError) {
      return {
        status: "incomplete",
        reason: `npm registry: ${error.message}`,
        durationMs: performance.now() - started,
      };
    }
    if (error instanceof TarballError || error instanceof BudgetError) {
      return {
        status: "incomplete",
        reason: `package contents: ${error.message}`,
        durationMs: performance.now() - started,
      };
    }
    throw error;
  }
}

/** Any listed version, to read package-level facts such as the creation date. */
function firstVersion(doc: unknown): string {
  const versions =
    typeof doc === "object" && doc !== null && "versions" in doc
      ? doc.versions
      : undefined;
  return typeof versions === "object" && versions !== null
    ? (Object.keys(versions)[0] ?? "")
    : "";
}

/**
 * Downloads each registry tarball (verified against the lockfile's integrity),
 * reads it in memory, and runs the content detectors. A tampered tarball is a
 * block; a plan over the download budget is incomplete, never partially clean.
 */
async function contentOf(
  changes: readonly PlanChange[],
  options: OnlineOptions,
): Promise<Finding[]> {
  const budget = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  let downloaded = 0;
  const fetchOptions =
    options.fetch === undefined ? {} : { fetch: options.fetch };
  const results = await pool(changes, 4, async (change): Promise<Finding[]> => {
    const { entry } = change;
    const label = `${entry.name}@${entry.version ?? "?"}`;
    const cached =
      entry.integrity === undefined
        ? undefined
        : options.cache?.get(entry.integrity, label);
    if (cached !== undefined) return cached;
    let data: Buffer;
    try {
      data = await fetchTarball(
        entry.resolved ?? "",
        entry.integrity,
        fetchOptions,
      );
    } catch (error) {
      if (!(error instanceof IntegrityError)) throw error;
      return [
        {
          ruleId: "install/integrity",
          severity: "block",
          file: label,
          message: `the downloaded tarball does not match the lockfile (${error.message}): tampered in transit or at the source`,
        },
      ];
    }
    downloaded += data.length;
    if (downloaded > budget)
      throw new BudgetError(
        `the plan downloads more than ${budget} bytes of tarballs`,
      );
    const findings = contentFindings(label, snapshotTarball(data));
    // Only after the download verified against this hash and was read whole.
    if (entry.integrity !== undefined)
      options.cache?.set(entry.integrity, label, findings);
    return findings;
  });
  return results.flat();
}

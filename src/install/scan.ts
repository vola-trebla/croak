import { performance } from "node:perf_hooks";
import { aggregate, type Finding, type Verdict } from "../verdict.ts";
import { type InstallDetector, installDetectors } from "./detectors.ts";
import { LockfileError, parseLockfile } from "./lockfile.ts";
import { metadataFindings } from "./metadata.ts";
import { diffLockfiles } from "./plan.ts";
import {
  fetchPackument,
  REGISTRY,
  RegistryError,
  versionFacts,
} from "./registry.ts";

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
}

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
  const changes = diffLockfiles(before, parseLockfile(afterText)).filter(
    (c) =>
      !c.entry.link &&
      c.entry.version !== undefined &&
      c.entry.resolved?.startsWith(`${REGISTRY}/`) === true,
  );
  const names = [...new Set(changes.map((c) => c.entry.name))];
  try {
    const fetchOptions =
      options.fetch === undefined ? {} : { fetch: options.fetch };
    const docs = await pool(names, options.concurrency ?? 8, (name) =>
      fetchPackument(name, fetchOptions),
    );
    const byName = new Map(names.map((name, i) => [name, docs[i]]));
    const now = options.now ?? new Date();
    const remote = changes.flatMap((c) => {
      const doc = byName.get(c.entry.name);
      const facts =
        doc === "not-found"
          ? "not-found"
          : versionFacts(doc, c.entry.version ?? "", now);
      return metadataFindings(c, facts, now);
    });
    const findings = [...local.findings, ...remote];
    return {
      ...local,
      verdict: aggregate(findings),
      findings,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
    return {
      status: "incomplete",
      reason: `npm registry: ${error.message}`,
      durationMs: performance.now() - started,
    };
  }
}

import { performance } from "node:perf_hooks";
import type { RegistryKey } from "../crypto/registry-signature.ts";
import {
  type SigstoreTrustRoot,
  type Subject,
  verifyProvenance,
} from "../crypto/sigstore.ts";
import { type LlmOptions, llmStep } from "../llm/plan-step.ts";
import { aggregate, type Finding, type Verdict } from "../verdict.ts";
import { contentFindings } from "./content.ts";
import type { ContentCache } from "./content-cache.ts";
import { type InstallDetector, installDetectors } from "./detectors.ts";
import {
  installsOn,
  type LockEntry,
  LockfileError,
  type Platform,
  parseLockfile,
} from "./lockfile.ts";
import { addedDependencyFindings, metadataFindings } from "./metadata.ts";
import { diffLockfiles, type PlanChange } from "./plan.ts";
import { applyBuildPolicy, type BuildPolicy } from "./pnpm-builds.ts";
import { isPnpmLockfile, parsePnpmLockfile } from "./pnpm-lockfile.ts";
import {
  type Provenance,
  provenanceBaseline,
  provenanceFindings,
} from "./provenance.ts";
import {
  fetchPackument,
  fetchProvenanceBundle,
  fetchTarball,
  IntegrityError,
  RegistryError,
  registryTarball,
  type VersionFacts,
  versionFacts,
} from "./registry.ts";
import { signatureFindings } from "./signature.ts";
import { snapshotTarball, TarballError } from "./tar.ts";

/** An npm package-lock.json or a pnpm-lock.yaml, told apart by their first lines. */
export function parseAnyLockfile(text: string): LockEntry[] {
  return isPnpmLockfile(text) ? parsePnpmLockfile(text) : parseLockfile(text);
}

export type PlanOutcome =
  | {
      readonly status: "complete";
      readonly verdict: Verdict;
      readonly findings: readonly Finding[];
      readonly added: number;
      readonly changed: number;
      /** The opt-in LLM step, when it ran (D36). */
      readonly llm?: {
        readonly model: string;
        readonly calls: number;
        readonly costUsd: number;
      };
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
      return parseAnyLockfile(text);
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
  /** Ask a model about packages the rules only warned about (opt-in, D36). */
  readonly llm?: LlmOptions;
  /** pnpm's rule for whose install scripts run (D38); absent: every script counts. */
  readonly builds?: BuildPolicy;
  /** Keys registry signatures are checked against (default: npm's, pinned; D42). */
  readonly registryKeys?: readonly RegistryKey[];
  /** Roots provenance is checked against (default: Sigstore's public good, pinned; D43). */
  readonly sigstore?: SigstoreTrustRoot;
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

/** The plan is too large to inspect within the download budget. */
class BudgetError extends Error {}

const keyOf = (s: Subject): string => `${s.name}@${s.version}`;

/** A planned version and what the registry says about it. */
interface Known {
  readonly change: PlanChange;
  readonly facts: VersionFacts | "not-found" | undefined;
}

/**
 * Provenance findings (D42, D43) for planned versions the registry lists
 * with provenance: each one's bundle, and its previous version's, fetched
 * and verified, then compared.
 */
async function provenanceOf(
  known: readonly Known[],
  options: OnlineOptions,
  fetchOptions: { fetch?: typeof globalThis.fetch },
): Promise<Finding[]> {
  const plans = known.flatMap(({ change, facts }) => {
    if (facts === undefined || facts === "not-found" || !facts.hasProvenance)
      return [];
    const subject = (version: string, integrity: string | undefined) => ({
      name: change.entry.name,
      version,
      integrity: integrity ?? "",
    });
    const before = provenanceBaseline(facts);
    const current = subject(change.entry.version ?? "", facts.integrity);
    const previous =
      before === undefined
        ? undefined
        : subject(before.version, before.integrity);
    // Both bundles are immutable for these tarballs, and so are both
    // versions' install scripts: the findings can be remembered.
    const label = `provenance ${keyOf(current)} after ${previous === undefined ? "none" : `${keyOf(previous)} ${previous.integrity}`}`;
    const cached = options.cache?.get(current.integrity, label);
    return [{ change, facts, before, current, previous, label, cached }];
  });
  const subjects = new Map<string, Subject>();
  for (const plan of plans)
    if (plan.cached === undefined)
      for (const s of [plan.current, plan.previous])
        if (s !== undefined) subjects.set(keyOf(s), s);
  const list = [...subjects.values()];
  const bundles = await pool(list, options.concurrency ?? 8, (s) =>
    fetchProvenanceBundle(s.name, s.version, fetchOptions),
  );
  const checked = new Map<string, Provenance>(
    list.map((s, i) => [
      keyOf(s),
      bundles[i] === "missing"
        ? "missing"
        : verifyProvenance(bundles[i], s, options.sigstore),
    ]),
  );
  return plans.flatMap((plan) => {
    if (plan.cached !== undefined) return plan.cached;
    const { change, facts, before, current, previous } = plan;
    const now = checked.get(keyOf(current)) ?? "missing";
    const then =
      previous === undefined
        ? undefined
        : (checked.get(keyOf(previous)) ?? "missing");
    const findings = provenanceFindings(
      change,
      now,
      before === undefined || then === undefined
        ? undefined
        : {
            version: before.version,
            provenance: then,
            installCommands: before.installCommands,
          },
      facts.installCommands,
    );
    // A bundle the registry did not serve may be served next time.
    if (now !== "missing" && then !== "missing")
      options.cache?.set(current.integrity, plan.label, findings);
    return findings;
  });
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
    beforeText === undefined ? undefined : parseAnyLockfile(beforeText);
  const fromRegistry = diffLockfiles(
    before,
    parseAnyLockfile(afterText),
  ).filter(
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
            file: isPnpmLockfile(afterText)
              ? "pnpm-lock.yaml"
              : "package-lock.json",
            message: `${skipped} package(s) built for other platforms not checked: the package manager will not install them on ${platform.os}-${platform.cpu}`,
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
    const known: Known[] = changes.map((change) => {
      const doc = byName.get(change.entry.name);
      return {
        change,
        facts:
          doc === "not-found"
            ? "not-found"
            : versionFacts(doc, change.entry.version ?? "", now),
      };
    });
    const remote = known.flatMap(({ change: c, facts }) => {
      const deps =
        facts === undefined || facts === "not-found"
          ? []
          : addedDependencyFindings(c, facts, created, now);
      const signature =
        facts === undefined || facts === "not-found"
          ? []
          : signatureFindings(c, facts, options.registryKeys);
      return [...metadataFindings(c, facts, now), ...signature, ...deps];
    });
    // Both only read the registry; neither waits for the other.
    const [provenance, content] = await Promise.all([
      provenanceOf(known, options, fetchOptions),
      options.content === false ? [] : contentOf(changes, options),
    ]);
    const all = [
      ...local.findings,
      ...notes,
      ...remote,
      ...provenance,
      ...content,
    ];
    // Before the LLM step: a script pnpm will not run needs no second opinion.
    const ruled =
      options.builds === undefined
        ? all
        : applyBuildPolicy(all, options.builds);
    const step =
      options.llm === undefined || options.content === false
        ? undefined
        : await llmStep(ruled, changes, byName, options.llm, fetchOptions);
    const findings = step?.findings ?? ruled;
    return {
      ...local,
      verdict: aggregate(findings),
      findings,
      ...(step === undefined || options.llm === undefined
        ? {}
        : {
            llm: {
              model: options.llm.model,
              calls: step.calls,
              costUsd: step.costUsd,
            },
          }),
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

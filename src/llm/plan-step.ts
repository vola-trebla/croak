import { performance } from "node:perf_hooks";
import type { PlanChange } from "../install/plan.ts";
import {
  type FetchOptions,
  fetchTarball,
  IntegrityError,
  RegistryError,
  tarballOf,
} from "../install/registry.ts";
import { snapshotTarball, TarballError } from "../install/tar.ts";
import type { Finding } from "../verdict.ts";
import { versionDiff } from "./diff.ts";
import { escalate, LLM_RULE, type LlmJudgement } from "./escalate.ts";
import { warnedPackages } from "./select.ts";
import { LlmError, type TriageFn } from "./triage.ts";

/**
 * The opt-in LLM step of croak plan (M5, D36). For each package the rules
 * only warned about, download this version and the previous one (both
 * verified against their integrity hashes), build the diff, and ask the
 * model. Its answers can only add findings. Anything that goes wrong here —
 * no previous tarball, a failed download, a model error — leaves the rules'
 * verdict as it is, with an info line saying the model did not judge.
 */

export interface LlmOptions {
  readonly triage: TriageFn;
  /** Shown in reports. */
  readonly model: string;
  /** Limits, so the step never outlasts the hook's timeout (M5 review). */
  readonly maxPackages?: number;
  readonly deadlineMs?: number;
  readonly maxDownloadBytes?: number;
}

const DEFAULT_MAX_PACKAGES = 10;
const DEFAULT_DEADLINE_MS = 90_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export interface LlmStep {
  readonly findings: Finding[];
  readonly calls: number;
  readonly costUsd: number;
}

export async function llmStep(
  findings: readonly Finding[],
  changes: readonly PlanChange[],
  docs: ReadonlyMap<string, unknown>,
  llm: LlmOptions,
  fetchOptions: FetchOptions,
): Promise<LlmStep> {
  const judgements: LlmJudgement[] = [];
  const notes: Finding[] = [];
  let calls = 0;
  let costUsd = 0;
  const skip = (label: string, why: string): void => {
    notes.push({
      ruleId: LLM_RULE,
      severity: "info",
      file: label,
      message: `${llm.model} did not judge it: ${why}`,
    });
  };
  const warned = new Set(warnedPackages(findings));
  const started = performance.now();
  const deadline = llm.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxPackages = llm.maxPackages ?? DEFAULT_MAX_PACKAGES;
  const maxBytes = llm.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  let downloaded = 0;
  let asked = 0;
  const download = async (
    url: string,
    integrity: string | undefined,
  ): Promise<Buffer> => {
    const left = maxBytes - downloaded;
    if (left <= 0)
      throw new RegistryError(
        `over the LLM step's ${maxBytes}-byte download budget`,
      );
    // fetchTarball stops reading at the cap, so the budget holds mid-download too.
    const data = await fetchTarball(url, integrity, {
      ...fetchOptions,
      maxBytes: Math.min(left, 100 * 1024 * 1024),
    });
    downloaded += data.length;
    return data;
  };
  // Every copy with a warning: D35 keeps same name@version from different
  // sources apart, and the warned one may not be the first (M5 review).
  for (const change of changes.filter((c) =>
    warned.has(`${c.entry.name}@${c.entry.version ?? "?"}`),
  )) {
    const { entry } = change;
    const label = `${entry.name}@${entry.version ?? "?"}`;
    const doc = docs.get(entry.name);
    if (asked >= maxPackages) {
      skip(label, `over the LLM step's limit of ${maxPackages} packages`);
      continue;
    }
    if (performance.now() - started > deadline) {
      skip(
        label,
        `over the LLM step's ${Math.round(deadline / 1000)} s budget`,
      );
      continue;
    }
    asked += 1;
    try {
      const after = snapshotTarball(
        await download(entry.resolved ?? "", entry.integrity),
      );
      // The baseline is what the project had: a new dependency is shown whole,
      // not as a delta from the registry's previous release (M5 review).
      const previous =
        change.kind === "changed" ? change.previousVersion : undefined;
      const prevTarball =
        previous === undefined ? undefined : tarballOf(doc, previous);
      const before =
        prevTarball === undefined
          ? undefined
          : snapshotTarball(
              await download(prevTarball.url, prevTarball.integrity),
            );
      const result = await llm.triage({
        label,
        previousVersion: previous,
        diff: versionDiff(before, after),
      });
      calls += 1;
      costUsd += result.costUsd ?? 0;
      judgements.push(result.judgement);
    } catch (error) {
      if (
        error instanceof LlmError ||
        error instanceof RegistryError ||
        error instanceof TarballError ||
        error instanceof IntegrityError
      )
        skip(label, error.message);
      else throw error;
    }
  }
  return {
    findings: [...escalate(findings, judgements), ...notes],
    calls,
    costUsd,
  };
}

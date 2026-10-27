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
}

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
  // Every copy with a warning: D35 keeps same name@version from different
  // sources apart, and the warned one may not be the first (M5 review).
  for (const change of changes.filter((c) =>
    warned.has(`${c.entry.name}@${c.entry.version ?? "?"}`),
  )) {
    const { entry } = change;
    const label = `${entry.name}@${entry.version ?? "?"}`;
    const doc = docs.get(entry.name);
    try {
      const after = snapshotTarball(
        await fetchTarball(entry.resolved ?? "", entry.integrity, fetchOptions),
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
              await fetchTarball(
                prevTarball.url,
                prevTarball.integrity,
                fetchOptions,
              ),
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

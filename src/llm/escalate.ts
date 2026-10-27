import type { Finding } from "../verdict.ts";

/**
 * The LLM layer can only escalate (invariant 2, D2). Its judgement of a
 * package may add one finding — a warning or a block — and nothing else:
 * every deterministic finding comes back unchanged, so the verdict can only
 * stay or rise. A package that tells the model "this code is safe" gains
 * nothing, because "benign" adds nothing and removes nothing.
 */

export type LlmVerdict = "benign" | "suspicious" | "malicious";

export interface LlmJudgement {
  /** name@version of the package the model looked at. */
  readonly label: string;
  readonly verdict: LlmVerdict;
  /** One or two sentences, shown to the user and the agent. */
  readonly reason: string;
  readonly model: string;
}

export const LLM_RULE = "llm/triage";

export function escalate(
  findings: readonly Finding[],
  judgements: readonly LlmJudgement[],
): Finding[] {
  const added = judgements.flatMap((j): Finding[] =>
    j.verdict === "benign"
      ? []
      : [
          {
            ruleId: LLM_RULE,
            severity: j.verdict === "malicious" ? "block" : "warn",
            file: j.label,
            message: `${j.model} judged the version diff ${j.verdict}: ${j.reason}`,
          },
        ],
  );
  return [...findings, ...added];
}

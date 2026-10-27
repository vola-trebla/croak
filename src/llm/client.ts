import { DEFAULT_MODEL, type TriageFn, triage } from "./triage.ts";

/**
 * The model for `croak plan --llm`, loaded on first use (M5 review, D36). The
 * SDK is the one runtime dependency; importing it statically would load it,
 * and its own dependencies, for every croak command — the hook's steps run
 * on every agent command, outside the sandbox. This literal dynamic import is
 * the only one the invariant tripwire allows.
 */
export function anthropicTriage(apiKey: string): TriageFn {
  let ready: Promise<TriageFn> | undefined;
  const load = async (): Promise<TriageFn> => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    // Well inside the hook's timeout; one retry for an overloaded API.
    const client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
    return (input) => triage(input, client);
  };
  return async (input) => {
    ready ??= load();
    return (await ready)(input);
  };
}

export { DEFAULT_MODEL };

/**
 * What one call cost, from the response's usage (USD). Prices are per million
 * tokens, from Anthropic's published table (Claude Haiku 5.5, 2026-10).
 */
export interface Price {
  readonly input: number;
  readonly output: number;
  /** Prompts above this many tokens are billed at the long-context price. */
  readonly longAbove?: number;
  readonly longInput?: number;
  readonly longOutput?: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    longAbove: 100_000,
    longInput: 0.5,
    longOutput: 2.5,
  },
};

export interface UsageLike {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

/** Cost in USD, or undefined for a model without a known price. */
export function costOf(model: string, usage: UsageLike): number | undefined {
  const price = PRICES[model];
  if (price === undefined) return undefined;
  const prompt =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const long = price.longAbove !== undefined && prompt > price.longAbove;
  const input = long ? (price.longInput ?? price.input) : price.input;
  const output = long ? (price.longOutput ?? price.output) : price.output;
  // Cache writes cost 1.25x and reads 0.1x the input price.
  const promptCost =
    usage.input_tokens * input +
    (usage.cache_creation_input_tokens ?? 0) * input * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * input * 0.1;
  return (promptCost + usage.output_tokens * output) / 1_000_000;
}

import { describe, expect, it } from "vitest";
import { costOf } from "./cost.ts";

describe("costOf", () => {
  it("prices Haiku 5.5 per million tokens", () => {
    expect(
      costOf("claude-haiku-5-5", {
        input_tokens: 50_000,
        output_tokens: 50_000,
      }),
    ).toBeCloseTo(0.03, 6);
    expect(
      costOf("claude-haiku-5-5", { input_tokens: 10_000, output_tokens: 200 }),
    ).toBeCloseTo(0.0011, 6);
  });

  it("uses the long-context price above 100K prompt tokens", () => {
    expect(
      costOf("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 0 }),
    ).toBeCloseTo(0.1, 6);
  });

  it("is undefined for a model without a known price", () => {
    expect(
      costOf("some-other-model", { input_tokens: 1, output_tokens: 1 }),
    ).toBeUndefined();
  });
});

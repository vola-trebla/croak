import { describe, expect, it } from "vitest";
import { timePatterns } from "./redos-check.ts";

describe("timePatterns", () => {
  it("exposes a catastrophic regex as the slowest run", () => {
    // Exponential backtracking, kept small enough to finish: about 2^22 steps.
    const input = `${" ".repeat(22)}x`;
    const runs = timePatterns(
      [
        { label: "linear", pattern: /\s+x/ },
        { label: "catastrophic", pattern: /^(\s+)+$/ },
      ],
      [input],
    );
    expect(runs[0]?.what).toBe("code/catastrophic");
    expect(runs[0]?.ms ?? 0).toBeGreaterThan((runs[1]?.ms ?? 0) * 10);
  });
});

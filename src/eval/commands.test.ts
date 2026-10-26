import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answer, loadCommandCases, runCommandEval } from "./commands.ts";

const cases = loadCommandCases(
  join(import.meta.dirname, "../../eval/agent-commands.json"),
);

describe("agent-command eval", () => {
  it("gives every command its expected answer, except the documented gaps", () => {
    const wrong = runCommandEval(cases)
      .results.filter((r) => r.got !== r.expect && r.knownGap !== true)
      .map((r) => `${r.command}: expected ${r.expect}, got ${r.got}`);
    expect(wrong).toEqual([]);
  });

  it("covers all three answers", () => {
    expect(new Set(cases.map((c) => c.expect))).toEqual(
      new Set(["check", "deny", "ignore"]),
    );
  });

  it("scores against the hook's own plan step", () => {
    expect(answer("npm i zod")).toBe("check");
    expect(answer("ls")).toBe("ignore");
  });
});

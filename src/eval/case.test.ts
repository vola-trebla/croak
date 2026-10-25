import { describe, expect, it } from "vitest";
import { CaseError, parseCase } from "./case.ts";

const valid = {
  id: "d-example",
  kind: "repo",
  threat: "D",
  description: "example",
  expect: { verdict: "block", rules: ["repo/lifecycle-script"] },
};

const parse = (raw: unknown) => parseCase("d-example", raw, "/fixture");

describe("parseCase", () => {
  it("accepts a valid case", () => {
    expect(parse(valid)).toEqual({ ...valid, fixtureDir: "/fixture" });
  });

  it.each([
    ["not an object", [], "JSON object"],
    ["id mismatch", { ...valid, id: "other" }, "directory name"],
    ["unknown kind", { ...valid, kind: "install" }, `"kind"`],
    ["unknown threat", { ...valid, threat: "Z" }, `"threat"`],
    ["empty description", { ...valid, description: " " }, `"description"`],
    [
      "bad verdict",
      { ...valid, expect: { ...valid.expect, verdict: "nope" } },
      "expect.verdict",
    ],
    [
      "bad rules",
      { ...valid, expect: { ...valid.expect, rules: [1] } },
      "expect.rules",
    ],
    [
      "benign expecting block",
      { ...valid, threat: "benign", expect: { verdict: "block", rules: [] } },
      "benign case cannot expect block",
    ],
    [
      "malicious expecting allow",
      { ...valid, expect: { verdict: "allow", rules: [] } },
      "malicious case cannot expect allow",
    ],
  ])("rejects %s", (_name, raw, message) => {
    expect(() => parse(raw)).toThrow(CaseError);
    expect(() => parse(raw)).toThrow(message);
  });
});

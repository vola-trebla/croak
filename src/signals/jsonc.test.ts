import { describe, expect, it } from "vitest";
import { JsoncError, MAX_JSONC_DEPTH, parseJsonc } from "./jsonc.ts";

describe("parseJsonc", () => {
  it("parses plain JSON", () => {
    expect(parseJsonc(`{"a": [1, 2], "b": "x"}`)).toEqual({
      a: [1, 2],
      b: "x",
    });
  });

  it("ignores line and block comments", () => {
    const text = `// SYNTHETIC header
{
  /* block
     comment */
  "version": "2.0.0", // trailing note
  "tasks": []
}`;
    expect(parseJsonc(text)).toEqual({ version: "2.0.0", tasks: [] });
  });

  it("accepts trailing commas in objects and arrays", () => {
    expect(parseJsonc(`{"a": [1, 2,], "b": {"c": 1,},}`)).toEqual({
      a: [1, 2],
      b: { c: 1 },
    });
    expect(
      parseJsonc(`[1, 2, // last
    ]`),
    ).toEqual([1, 2]);
  });

  it("keeps comment-like text and commas inside strings", () => {
    expect(
      parseJsonc(
        `{"url": "https://x.invalid/a", "s": "/* not a comment */", "t": "a,}"}`,
      ),
    ).toEqual({
      url: "https://x.invalid/a",
      s: "/* not a comment */",
      t: "a,}",
    });
    expect(parseJsonc(`{"q": "say \\"hi\\" // still a string"}`)).toEqual({
      q: 'say "hi" // still a string',
    });
  });

  it.each([
    ["an unterminated block comment", `{"a": 1 /* oops`],
    ["an unterminated string", `{"a": "oops}`],
    ["invalid JSON", `{a: 1}`],
    ["empty input", ``],
  ])("throws JsoncError on %s", (_name, text) => {
    expect(() => parseJsonc(text)).toThrow(JsoncError);
  });

  it("refuses nesting deeper than the limit instead of recursing", () => {
    const deep =
      "[".repeat(MAX_JSONC_DEPTH + 1) + "]".repeat(MAX_JSONC_DEPTH + 1);
    expect(() => parseJsonc(deep)).toThrow(/nested/);
    const ok = "[".repeat(MAX_JSONC_DEPTH) + "]".repeat(MAX_JSONC_DEPTH);
    expect(() => parseJsonc(ok)).not.toThrow();
  });
});

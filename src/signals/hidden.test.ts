// croak-invariants: pattern-data
// Inputs below are detector test data, not code (D16).
import { describe, expect, it } from "vitest";
import { hiddenCode, MIN_BLANK_LINES, MIN_GAP } from "./hidden.ts";

describe("hiddenCode: offscreen", () => {
  it("finds code after a long run of spaces on the same line", () => {
    const text = `module.exports = {};${" ".repeat(320)}eval(payload);\n`;
    expect(hiddenCode(text)).toEqual([
      { kind: "offscreen", line: 1, column: 341, hidden: "eval(payload);" },
    ]);
  });

  it("counts tabs as whitespace and reports the right line", () => {
    const text = `ok\nconst a = 1;${"\t".repeat(MIN_GAP)}run()\n`;
    expect(hiddenCode(text)).toMatchObject([
      { kind: "offscreen", line: 2, hidden: "run()" },
    ]);
  });

  it("ignores a long run of trailing whitespace with nothing after it", () => {
    expect(hiddenCode(`const a = 1;${" ".repeat(500)}\n`)).toEqual([]);
  });

  it("ignores gaps below the threshold, like aligned tables", () => {
    const table = [
      "name        value",
      "alpha       1",
      `beta${" ".repeat(MIN_GAP - 1)}2`,
    ].join("\n");
    expect(hiddenCode(table)).toEqual([]);
  });

  it("ignores long lines without gaps: minified code and safelists", () => {
    const minified = `!function(t,e){${"var a=1;".repeat(2000)}}();`;
    const safelist = `safelist: [${Array.from({ length: 500 }, (_, i) => `"bg-${i}"`).join(", ")}]`;
    expect(hiddenCode(`${minified}\n${safelist}\n`)).toEqual([]);
  });
});

describe("hiddenCode: vertical", () => {
  it("finds code after hundreds of blank lines", () => {
    const text = `export default {};\n${"\n".repeat(MIN_BLANK_LINES)}eval(payload);\n`;
    expect(hiddenCode(text)).toMatchObject([
      { kind: "vertical", line: MIN_BLANK_LINES + 2, hidden: "eval(payload);" },
    ]);
  });

  it("treats whitespace-only lines as blank", () => {
    const text = `a\n${"   \n".repeat(MIN_BLANK_LINES)}b\n`;
    expect(hiddenCode(text)).toMatchObject([{ kind: "vertical" }]);
  });

  it("ignores ordinary spacing and blank lines at the end of a file", () => {
    expect(hiddenCode(`a\n\n\n\nb\n`)).toEqual([]);
    expect(hiddenCode(`a\n${"\n".repeat(MIN_BLANK_LINES * 2)}`)).toEqual([]);
  });
});

describe("hiddenCode: bidi controls (Trojan Source)", () => {
  it.each(["‮", "⁦", "⁩", "‪"])("finds U+%s", (char) => {
    const text = `const isAdmin = false;\nif (isAdmin${char}) { grant(); }\n`;
    expect(hiddenCode(text)).toMatchObject([
      { kind: "bidi", line: 2, column: 12 },
    ]);
  });

  it("ignores ordinary non-ASCII text", () => {
    expect(hiddenCode(`const greeting = "Привет, 世界 🐸";\n`)).toEqual([]);
  });
});

it("handles CRLF line endings", () => {
  expect(hiddenCode(`a\r\nb;${" ".repeat(MIN_GAP)}c\r\n`)).toMatchObject([
    { kind: "offscreen", line: 2, hidden: "c" },
  ]);
});

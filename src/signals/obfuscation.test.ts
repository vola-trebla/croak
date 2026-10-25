import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ObfuscationKind, obfuscationSignals } from "./obfuscation.ts";

const kinds = (text: string): ObfuscationKind[] =>
  obfuscationSignals(text).map((h) => h.kind);

describe("obfuscationSignals", () => {
  it("flags dense hex and unicode escapes on one line", () => {
    expect(
      kinds(`const s = "\\x65\\x76\\x61\\x6c\\x61\\x74\\x6f\\x62\\x63\\x64";`),
    ).toEqual(["escapes"]);
    expect(
      kinds(
        `const s = "\\u0065\\u0076\\u0061\\u006c\\u0061\\u0074\\u006f\\u0062";`,
      ),
    ).toEqual(["escapes"]);
  });

  it("ignores ordinary escapes and a few hex escapes", () => {
    expect(
      kinds(`log("a\\nb\\tc\\"d\\\\e"); const nbsp = "\\xa0\\x20";`),
    ).toEqual([]);
  });

  it("flags javascript-obfuscator names across the file, at the first line seen", () => {
    expect(
      obfuscationSignals(`const _0x3f1a = [];\nfoo();\nbar(_0x3f1a, _0x9c2e);`),
    ).toEqual([{ kind: "obfuscator-names", line: 1, count: 3 }]);
    expect(kinds(`const _0x3f1a = 1; use(_0x3f1a);`)).toEqual([]);
  });

  it("flags the string-array rotation signature", () => {
    expect(
      kinds(
        `while (!![]) { try { a['push'](a['shift']()); } catch (e) { a.push(a.shift()); } }`,
      ),
    ).toContain("string-array");
  });

  it.each([
    ["obfuscated name", `globalThis[_0x3f1a[0]](payload);`],
    ["variable", `window[fn](arg);`],
    ["self", `self[k](x);`],
    ["string-keyed eval", `globalThis["eval"](code);`],
    ["string-keyed Function", `window['Function'](code)();`],
  ])("flags a dynamic global call: %s", (_name, text) => {
    expect(kinds(text)).toContain("dynamic-call");
  });

  it.each([
    ["property call", `window.addEventListener("load", f);`],
    ["global index without call", `const v = globalThis[key];`],
    ["object, not a global", `handlers[type](event);`],
    ["literal property", `window["requestAnimationFrame"](tick);`],
  ])("does not flag %s", (_name, text) => {
    expect(kinds(text)).toEqual([]);
  });

  it("flags a long base64 string literal but not a data URI or a short token", () => {
    expect(kinds(`const blob = "${"QUJD".repeat(60)}";`)).toEqual([
      "encoded-blob",
    ]);
    expect(
      kinds(`img.src = "data:image/png;base64,${"iVBO".repeat(80)}";`),
    ).toEqual([]);
    expect(kinds(`const token = "${"QUJD".repeat(10)}";`)).toEqual([]);
  });

  it("gives minified code no signals at all", () => {
    const vendor = readFileSync(
      join(
        import.meta.dirname,
        "../../eval/cases/benign-minified-vendor/fixture/public/vendor/chart-lite.min.js",
      ),
      "utf8",
    );
    expect(obfuscationSignals(vendor)).toEqual([]);
  });

  it("reports line numbers and counts for line-level signals", () => {
    const line = `x("\\x61\\x62\\x63\\x64\\x65\\x66\\x67\\x68\\x69")`;
    expect(obfuscationSignals(`ok\n${line}`)).toEqual([
      { kind: "escapes", line: 2, count: 9 },
    ]);
  });
});

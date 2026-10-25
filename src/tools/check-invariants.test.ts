import { describe, expect, it } from "vitest";
import { checkPackageJson, checkSource } from "./check-invariants.ts";

const rules = (text: string) =>
  checkSource("src/x.ts", text).map((v) => v.rule);

describe("checkSource", () => {
  it("passes ordinary read-only code", () => {
    expect(
      rules(
        `import { readFileSync } from "node:fs";\nconst t = readFileSync(p, "utf8");`,
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "child_process",
      `import { spawn } from "node:child_process";`,
      "no-process-spawn",
    ],
    [
      "bare child_process",
      `import cp from "child_process";`,
      "no-process-spawn",
    ],
    ["vm", `import vm from "node:vm";`, "no-vm"],
    [
      "worker_threads",
      `import { Worker } from "node:worker_threads";`,
      "no-workers",
    ],
    [
      "createRequire",
      `import { createRequire } from "node:module";`,
      "no-module-loader",
    ],
    ["eval", `eval(code);`, "no-eval"],
    ["new Function", `const f = new Function("return 1");`, "no-eval"],
    ["require", `const x = require(name);`, "no-require"],
    ["dynamic import", `const m = await import(path);`, "no-dynamic-import"],
    ["writeFileSync", `writeFileSync(p, data);`, "no-fs-write"],
    ["mkdir", `await mkdir(p);`, "no-fs-write"],
    ["rmSync", `rmSync(p, { recursive: true });`, "no-fs-write"],
    ["createWriteStream", `createWriteStream(p);`, "no-fs-write"],
  ])("flags %s", (_name, text, rule) => {
    expect(rules(text)).toContain(rule);
  });

  it("does not confuse lookalikes", () => {
    expect(
      rules(
        `retrieval(x); const evaluate = 1; myrequire(x); renameVar(); import type { A } from "./a.ts";`,
      ),
    ).toEqual([]);
  });

  it("reports the line number", () => {
    expect(checkSource("src/x.ts", "ok\nok\neval(x)\n")).toEqual([
      { file: "src/x.ts", line: 3, rule: "no-eval", text: "eval(x)" },
    ]);
  });
});

describe("checkPackageJson", () => {
  it("passes a manifest with only devDependencies", () => {
    expect(
      checkPackageJson({
        devDependencies: { vitest: "1" },
        scripts: { test: "vitest" },
      }),
    ).toEqual([]);
  });

  it.each([
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
  ])("flags non-empty %s", (field) => {
    expect(
      checkPackageJson({ [field]: { left_pad: "1" } }).map((v) => v.rule),
    ).toEqual(["no-runtime-deps"]);
  });

  it("ignores empty dependency objects", () => {
    expect(checkPackageJson({ dependencies: {} })).toEqual([]);
  });

  it.each(["preinstall", "install", "postinstall", "prepare"])(
    "flags a %s script in croak itself",
    (script) => {
      expect(
        checkPackageJson({ scripts: { [script]: "node x.js" } }).map(
          (v) => v.rule,
        ),
      ).toEqual(["no-install-scripts"]);
    },
  );
});

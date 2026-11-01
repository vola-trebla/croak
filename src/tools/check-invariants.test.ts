import { describe, expect, it } from "vitest";
import {
  checkPackageJson,
  checkSource,
  checkWorkflow,
  PATTERN_DATA_MARKER,
} from "./check-invariants.ts";

const rules = (text: string, isTest = false) =>
  checkSource("src/x.ts", text, isTest).map((v) => v.rule);

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
    ["inspector", `import inspector from "node:inspector";`, "no-inspector"],
    ["repl", `import repl from "repl";`, "no-inspector"],
    ["eval", `eval(code);`, "no-eval"],
    ["indirect eval", `(0, eval)(code);`, "no-eval"],
    ["new Function", `const f = new Function("return 1");`, "no-eval"],
    ["Function without new", `Function("return 1")();`, "no-eval"],
    ["process.binding", `process.binding("spawn_sync");`, "no-eval"],
    ["process.dlopen", `process.dlopen(m, p);`, "no-eval"],
    ["require", `const x = require(name);`, "no-require"],
    [
      "getBuiltinModule",
      `const cp = process.getBuiltinModule("node:child_process");`,
      "no-builtin-loader",
    ],
    ["dynamic import", `const m = await import(path);`, "no-dynamic-import"],
    ["writeFileSync", `writeFileSync(p, data);`, "no-fs-write"],
    ["writeSync", `writeSync(fd, data);`, "no-fs-write"],
    ["mkdir", `await mkdir(p);`, "no-fs-write"],
    ["rmSync", `rmSync(p, { recursive: true });`, "no-fs-write"],
    ["createWriteStream", `createWriteStream(p);`, "no-fs-write"],
    ["open for writing", `openSync(p, "w");`, "no-fs-write"],
    [
      "write flags",
      `openSync(p, constants.O_WRONLY | constants.O_CREAT);`,
      "no-fs-write",
    ],
    ["ftruncate", `ftruncateSync(fd);`, "no-fs-write"],
    [
      "eval marker",
      `if (text.includes("croak-eval-synthetic")) block();`,
      "no-eval-marker",
    ],
    [
      "eval marker comment",
      `// SYNTHETIC croak eval fixture`,
      "no-eval-marker",
    ],
  ])("flags %s", (_name, text, rule) => {
    expect(rules(text)).toContain(rule);
  });

  it.each([
    [
      "lookalike names",
      `retrieval(x); const evaluate = 1; myrequire(x); renameVar(); isFunction(f);`,
    ],
    ["type-only import", `import type { A } from "./a.ts";`],
    ["package type field", `if (pkg.type === "module") esm = true;`],
    ["a truncate helper", `const short = truncate(line, 120);`],
    ["stdout writes", `process.stdout.write(text);`],
    [
      "read-only open",
      `openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);`,
    ],
  ])("does not flag %s", (_name, text) => {
    expect(rules(text)).toEqual([]);
  });

  it("applies execution rules to test files too", () => {
    expect(rules(`await import(join(CASES, "next.config.js"));`, true)).toEqual(
      ["no-dynamic-import"],
    );
    expect(
      rules(
        `execSync("x"); import { execSync } from "node:child_process";`,
        true,
      ),
    ).toContain("no-process-spawn");
  });

  it("lets test files write fixtures, mention the eval marker, and hold eval-like data", () => {
    expect(rules(`writeFileSync(p, "x"); mkdirSync(d);`, true)).toEqual([]);
    expect(
      rules(`expect(scan('eval(atob("eA=="))')).toBe(true);`, true),
    ).toEqual([]);
    expect(
      rules(`expect(text).toContain("croak-eval-synthetic");`, true),
    ).toEqual([]);
  });

  it("reports the line number", () => {
    expect(checkSource("src/x.ts", "ok\nok\neval(x)\n", false)).toEqual([
      { file: "src/x.ts", line: 3, rule: "no-eval", text: "eval(x)" },
    ]);
  });
});

describe("pattern-data files", () => {
  const data = (body: string, file = "src/signals/x.ts", isTest = false) =>
    checkSource(file, `${PATTERN_DATA_MARKER}\n${body}`, isTest).map(
      (v) => v.rule,
    );

  it("allow forbidden module names and calls as data inside strings", () => {
    expect(
      data(
        `  ["https", \`const h = require("https");\`],\n  "child_process",\n  pattern: load("vm"),`,
      ),
    ).toEqual([]);
    expect(
      data(`  [\`eval(atob(x))\`, "eval"],`, "src/detectors/x.test.ts", true),
    ).toEqual([]);
  });

  it.each([
    [
      "an import statement",
      `import { execSync } from "node:child_process";`,
      "no-forbidden-import",
    ],
    [
      "a re-export",
      `export { runInThisContext } from "vm";`,
      "no-forbidden-import",
    ],
    [
      "a require statement",
      `const cp = require("child_process");`,
      "no-require",
    ],
    [
      "a dynamic import statement",
      `const m = await import(path);`,
      "no-dynamic-import",
    ],
    ["an eval statement", `  eval(code);`, "no-eval"],
    ["an indirect eval statement", `const r = (0, eval)(code);`, "no-eval"],
    [
      "a Function constructor statement",
      `const f = new Function(code);`,
      "no-eval",
    ],
    [
      "the closing line of a multi-line import",
      `} from "node:child_process";`,
      "no-forbidden-import",
    ],
    [
      "a getBuiltinModule statement",
      `const cp = process.getBuiltinModule("node:child_process");`,
      "no-builtin-loader",
    ],
    ["a process.dlopen statement", `process.dlopen(m, p);`, "no-eval"],
  ])("still flag %s", (_name, body, rule) => {
    expect(data(body)).toContain(rule);
  });

  it("keep the fs-write rule for non-test pattern-data files", () => {
    expect(data(`writeFileSync(p, d);`)).toContain("no-fs-write");
    expect(data(`writeFileSync(p, d);`, "src/signals/x.test.ts", true)).toEqual(
      [],
    );
  });

  it("refuse the marker outside src/signals and src/detectors", () => {
    expect(data("ok", "src/eval/x.ts")).toEqual([
      "pattern-data-outside-allowed-dirs",
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
    "bundledDependencies",
  ])("flags non-empty %s", (field) => {
    expect(
      checkPackageJson({ [field]: { left_pad: "1" } }).map((v) => v.rule),
    ).toEqual(["no-runtime-deps"]);
  });

  it("allows only the official Anthropic SDK, pinned exactly (D36)", () => {
    expect(
      checkPackageJson({ dependencies: { "@anthropic-ai/sdk": "0.133.0" } }),
    ).toEqual([]);
    expect(
      checkPackageJson({
        dependencies: { "@anthropic-ai/sdk": "^0.133.0" },
      }).map((v) => v.rule),
    ).toEqual(["no-runtime-deps"]);
    expect(
      checkPackageJson({
        optionalDependencies: { "@anthropic-ai/sdk": "0.133.0" },
      }).map((v) => v.rule),
    ).toEqual(["no-runtime-deps"]);
    expect(
      checkPackageJson({
        dependencies: { "@anthropic-ai/sdk": "0.133.0", left_pad: "1.0.0" },
      }).map((v) => v.text),
    ).toEqual(["dependencies: left_pad"]);
  });

  it("ignores empty dependency objects", () => {
    expect(checkPackageJson({ dependencies: {} })).toEqual([]);
  });

  it.each([
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
  ])("flags a %s script in croak itself", (script) => {
    expect(
      checkPackageJson({ scripts: { [script]: "node x.js" } }).map(
        (v) => v.rule,
      ),
    ).toEqual(["no-install-scripts"]);
  });
});

describe("the write allowlist (D33)", () => {
  it("lets only the content cache write, and only that rule", () => {
    const write = "writeFileSync(p, d);";
    expect(checkSource("src/install/content-cache.ts", write, false)).toEqual(
      [],
    );
    expect(
      checkSource("src/install/scan.ts", write, false).map((v) => v.rule),
    ).toEqual(["no-fs-write"]);
    expect(
      checkSource(
        "src/install/content-cache.ts",
        `import { exec } from "node:child_process";`,
        false,
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("the SDK import allowance (D36)", () => {
  const line =
    '    const { default: Anthropic } = await import("@anthropic-ai/sdk");';
  it("allows exactly the SDK's literal dynamic import, in exactly one file", () => {
    expect(checkSource("src/llm/client.ts", line, false)).toEqual([]);
    expect(checkSource("src/cli.ts", line, false).map((v) => v.rule)).toEqual([
      "no-dynamic-import",
    ]);
    expect(
      checkSource(
        "src/llm/client.ts",
        "const m = await import(name);",
        false,
      ).map((v) => v.rule),
    ).toEqual(["no-dynamic-import"]);
  });
});

describe("checkWorkflow", () => {
  const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  const flagged = (text: string) =>
    checkWorkflow(".github/workflows/x.yml", text).map((v) => v.text);

  it("passes actions pinned by commit SHA, and local actions", () => {
    expect(
      flagged(
        [
          "steps:",
          `  - uses: actions/checkout@${sha} # v7.0.1`,
          `    uses: github/codeql-action/init@${sha}`,
          "  - uses: ./.github/actions/setup",
          "  - run: echo uses: anything",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it.each([
    "actions/checkout@v7",
    "actions/checkout@main",
    "actions/checkout",
    `actions/checkout@${sha.slice(0, 12)}`,
    `"actions/checkout@v7"`,
    "docker://alpine:3",
  ])("flags an action that is not pinned by SHA: %s", (ref) => {
    expect(flagged(`steps:\n  - uses: ${ref}`)).toEqual([
      expect.stringContaining("uses:"),
    ]);
  });

  it.each([
    "  - { uses: actions/checkout@v7, with: { fetch-depth: 1 } }",
    '  - "uses": actions/checkout@v7',
    "  - 'uses' : actions/checkout@v7",
  ])("flags other YAML spellings of uses: %s", (line) => {
    expect(flagged(`steps:\n${line}`)).toHaveLength(1);
  });

  it("passes those spellings when pinned", () => {
    expect(
      flagged(`steps:\n  - { uses: actions/checkout@${sha}, with: {} }`),
    ).toEqual([]);
  });

  it("reports the line", () => {
    expect(
      checkWorkflow("w.yml", "on: push\nsteps:\n  - uses: a/b@v1"),
    ).toEqual([
      {
        file: "w.yml",
        line: 3,
        rule: "pinned-actions",
        text: "- uses: a/b@v1",
      },
    ]);
  });
});

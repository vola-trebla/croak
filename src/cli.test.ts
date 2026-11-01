import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliDeps, EXIT, EXIT_USAGE, run, VERSION } from "./cli.ts";
import type { PlanOutcome } from "./install/scan.ts";
import { type ScanOutcome, ScanTargetError } from "./scan.ts";

describe("cli", () => {
  it("prints the version npm publishes (package.json)", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ version: VERSION });
  });

  it.each([["--version"], ["-v"]])(
    "prints the version with %s",
    async (flag) => {
      expect(await run([flag])).toEqual({
        code: 0,
        stdout: `${VERSION}\n`,
        stderr: "",
      });
    },
  );

  it.each([[[]], [["--help"]], [["-h"]]])(
    "prints help for %j",
    async (argv) => {
      const result = await run(argv);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("croak before you install");
      expect(result.stderr).toBe("");
    },
  );

  it("reports an unknown flag as a usage error, not a crash", async () => {
    const result = await run(["--yolo"]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--yolo");
    expect(result.stderr).toContain("Usage:");
  });

  it("reports an unexpected argument as a usage error", async () => {
    const result = await run(["install", "lodash"]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("install");
  });
});

const outcome = (verdict: "allow" | "warn" | "block"): ScanOutcome => ({
  status: "complete",
  root: ".",
  verdict,
  filesScanned: 1,
  durationMs: 1,
  findings:
    verdict === "allow"
      ? []
      : [{ ruleId: "r/x", severity: verdict, file: "a.js", message: "m" }],
});

const deps = (result: ScanOutcome | Error, seen: string[] = []): CliDeps => ({
  emoji: false,
  scan: (root) => {
    seen.push(root);
    if (result instanceof Error) throw result;
    return result;
  },
});

describe("croak repo", () => {
  it("scans the given path, defaulting to the current directory", async () => {
    const seen: string[] = [];
    await run(["repo", "some/dir"], deps(outcome("allow"), seen));
    await run(["repo"], deps(outcome("allow"), seen));
    expect(seen).toEqual(["some/dir", "."]);
  });

  it.each([
    ["allow", EXIT.ok],
    ["warn", EXIT.ok],
    ["block", EXIT.block],
  ] as const)("exits %s → %i", async (verdict, code) => {
    expect((await run(["repo", "."], deps(outcome(verdict)))).code).toBe(code);
  });

  it("exits 3 when the scan could not complete, so agents can fail closed", async () => {
    const incomplete: ScanOutcome = {
      status: "incomplete",
      root: ".",
      reason: "too deep",
      durationMs: 1,
    };
    const result = await run(["repo", "."], deps(incomplete));
    expect(result.code).toBe(EXIT.incomplete);
    expect(result.stdout).toContain("too deep");
  });

  it("reports a missing or non-directory target as a usage error", async () => {
    const result = await run(
      ["repo", "nope"],
      deps(new ScanTargetError("nope is not a directory")),
    );
    expect(result).toMatchObject({ code: EXIT_USAGE, stdout: "" });
    expect(result.stderr).toContain("nope is not a directory");
  });

  it("prints JSON with --json", async () => {
    const result = await run(["repo", ".", "--json"], deps(outcome("block")));
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 1,
      verdict: "block",
    });
    expect(result.code).toBe(EXIT.block);
  });

  it("rejects unknown commands and extra arguments", async () => {
    expect((await run(["scan", "."], deps(outcome("allow")))).code).toBe(
      EXIT_USAGE,
    );
    expect((await run(["repo", "a", "b"], deps(outcome("allow")))).code).toBe(
      EXIT_USAGE,
    );
  });
});

describe("croak plan", () => {
  const lock = (pkgs: object) =>
    JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...pkgs } });
  const files: Record<string, string> = {
    "before.json": lock({
      "node_modules/a": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
        integrity: "sha512-x",
      },
    }),
    "after.json": lock({
      "node_modules/a": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
        integrity: "sha512-x",
      },
      "node_modules/b": {
        version: "1.0.0",
        resolved: "git+https://x.invalid/b.git",
        integrity: "sha512-y",
      },
    }),
  };
  const planDeps: CliDeps = {
    emoji: false,
    scan: () => {
      throw new Error("not used");
    },
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
  };

  it("compares two lockfiles and reports a verdict", async () => {
    const result = await run(
      ["plan", "--before", "before.json", "--after", "after.json", "--offline"],
      planDeps,
    );
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("croak plan");
    expect(result.stdout).toContain("install/source");
  });

  it("treats --before none as a fresh install", async () => {
    const result = await run(
      [
        "plan",
        "--before",
        "none",
        "--after",
        "after.json",
        "--json",
        "--offline",
      ],
      planDeps,
    );
    const report: PlanOutcome & { schema: number } = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schema: 1, kind: "install-plan", added: 2 });
  });

  it("is incomplete when the folder is not a member of the workspace it planned at (M6 review)", async () => {
    const ws = {
      ...planDeps,
      readFile: (path: string) =>
        path === "ws.json"
          ? lock({ "packages/a": { name: "a", version: "1.0.0" } })
          : (planDeps.readFile?.(path) ?? ""),
    };
    const plan = (member: string) =>
      run(
        [
          ...["plan", "--before", "none", "--after", "ws.json", "--offline"],
          ...["--member", member],
        ],
        ws,
      );
    expect((await plan("packages/a")).code).toBe(EXIT.ok);
    expect(await plan("examples/demo")).toMatchObject({
      code: EXIT.incomplete,
      stdout: expect.stringContaining("does not list it as a member"),
    });
  });

  it("requires --after and readable files", async () => {
    expect((await run(["plan"], planDeps)).code).toBe(EXIT_USAGE);
    expect(
      await run(["plan", "--after", "missing.json"], planDeps),
    ).toMatchObject({
      code: EXIT_USAGE,
      stderr: expect.stringContaining("missing.json"),
    });
  });
});

describe("croak suggest", () => {
  it("names each package the plan's log could not find, with a did-you-mean when it can place one", async () => {
    const log = [
      "npm error 404 Not Found - GET https://registry.npmjs.org/lodahs - Not found",
      "error (404 Not Found) for url (https://registry.npmjs.org/zzzzzzzzqq)",
    ].join("\n");
    const result = await run(["suggest", "--log", "plan.log"], {
      ...deps(outcome("allow")),
      readFile: () => log,
    });
    expect(result).toMatchObject({
      code: 0,
      stdout:
        "  lodahs: not on npm; did you mean `lodash`?\n  zzzzzzzzqq: not on npm\n",
    });
  });

  it("says nothing when the log names no package", async () => {
    const result = await run(["suggest", "--log", "plan.log"], {
      ...deps(outcome("allow")),
      readFile: () => "npm error 404",
    });
    expect(result).toMatchObject({ code: 0, stdout: "" });
  });
});

describe("croak plan --llm without a key", () => {
  it("runs the rules and says the model did not run", async () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {} } });
    const result = await run(
      ["plan", "--after", "after.json", "--offline", "--json", "--llm"],
      {
        ...deps(outcome("allow")),
        readFile: () => lock,
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).findings).toEqual([]);
    const online = await run(
      ["plan", "--after", "after.json", "--json", "--llm", "--metadata-only"],
      {
        ...deps(outcome("allow")),
        readFile: () => lock,
        fetch: async () => new Response("{}"),
      },
    );
    expect(JSON.parse(online.stdout).findings).toEqual([
      expect.objectContaining({
        ruleId: "llm/triage",
        message: expect.stringContaining("ANTHROPIC_API_KEY"),
      }),
    ]);
  });
});

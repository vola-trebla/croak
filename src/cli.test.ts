import { describe, expect, it } from "vitest";
import { type CliDeps, EXIT, EXIT_USAGE, run, VERSION } from "./cli.ts";
import { type ScanOutcome, ScanTargetError } from "./scan.ts";

describe("cli", () => {
  it.each([["--version"], ["-v"]])("prints the version with %s", (flag) => {
    expect(run([flag])).toEqual({
      code: 0,
      stdout: `${VERSION}\n`,
      stderr: "",
    });
  });

  it.each([[[]], [["--help"]], [["-h"]]])("prints help for %j", (argv) => {
    const result = run(argv);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("croak before you install");
    expect(result.stderr).toBe("");
  });

  it("reports an unknown flag as a usage error, not a crash", () => {
    const result = run(["--yolo"]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--yolo");
    expect(result.stderr).toContain("Usage:");
  });

  it("reports an unexpected argument as a usage error", () => {
    const result = run(["install", "lodash"]);
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
  it("scans the given path, defaulting to the current directory", () => {
    const seen: string[] = [];
    run(["repo", "some/dir"], deps(outcome("allow"), seen));
    run(["repo"], deps(outcome("allow"), seen));
    expect(seen).toEqual(["some/dir", "."]);
  });

  it.each([
    ["allow", EXIT.ok],
    ["warn", EXIT.ok],
    ["block", EXIT.block],
  ] as const)("exits %s → %i", (verdict, code) => {
    expect(run(["repo", "."], deps(outcome(verdict))).code).toBe(code);
  });

  it("exits 3 when the scan could not complete, so agents can fail closed", () => {
    const incomplete: ScanOutcome = {
      status: "incomplete",
      root: ".",
      reason: "too deep",
      durationMs: 1,
    };
    const result = run(["repo", "."], deps(incomplete));
    expect(result.code).toBe(EXIT.incomplete);
    expect(result.stdout).toContain("too deep");
  });

  it("reports a missing or non-directory target as a usage error", () => {
    const result = run(
      ["repo", "nope"],
      deps(new ScanTargetError("nope is not a directory")),
    );
    expect(result).toMatchObject({ code: EXIT_USAGE, stdout: "" });
    expect(result.stderr).toContain("nope is not a directory");
  });

  it("prints JSON with --json", () => {
    const result = run(["repo", ".", "--json"], deps(outcome("block")));
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 1,
      verdict: "block",
    });
    expect(result.code).toBe(EXIT.block);
  });

  it("rejects unknown commands and extra arguments", () => {
    expect(run(["scan", "."], deps(outcome("allow"))).code).toBe(EXIT_USAGE);
    expect(run(["repo", "a", "b"], deps(outcome("allow"))).code).toBe(
      EXIT_USAGE,
    );
  });
});

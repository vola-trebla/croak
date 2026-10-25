import { describe, expect, it } from "vitest";
import { EXIT_USAGE, run, VERSION } from "./cli.ts";

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

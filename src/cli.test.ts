import { describe, expect, it } from "vitest";
import { run, VERSION } from "./cli.js";

describe("cli", () => {
  it("prints the version", () => {
    expect(run(["--version"])).toEqual({ code: 0, stdout: `${VERSION}\n` });
  });

  it("prints help by default", () => {
    const result = run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("croak before you install");
  });

  it("rejects unknown flags instead of ignoring them", () => {
    expect(() => run(["--yolo"])).toThrow();
  });
});

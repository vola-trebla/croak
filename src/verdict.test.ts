import { describe, expect, it } from "vitest";
import { aggregate, type Finding, isVerdict } from "./verdict.ts";

const finding = (severity: Finding["severity"]): Finding => ({
  ruleId: "test/rule",
  severity,
  file: "package.json",
  message: "test",
});

describe("aggregate", () => {
  it("allows when there are no findings", () => {
    expect(aggregate([])).toBe("allow");
  });

  it("takes the most severe finding regardless of order", () => {
    expect(
      aggregate([finding("warn"), finding("block"), finding("warn")]),
    ).toBe("block");
    expect(aggregate([finding("warn")])).toBe("warn");
  });

  it("never lets an info finding change the verdict", () => {
    expect(aggregate([finding("info")])).toBe("allow");
    expect(aggregate([finding("info"), finding("warn"), finding("info")])).toBe(
      "warn",
    );
  });
});

describe("isVerdict", () => {
  it.each(["allow", "warn", "block"])("accepts %s", (value) => {
    expect(isVerdict(value)).toBe(true);
  });

  it.each(["ALLOW", "", 1, null, undefined])("rejects %j", (value) => {
    expect(isVerdict(value)).toBe(false);
  });
});

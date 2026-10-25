import { describe, expect, it } from "vitest";
import { renderScan, safe, scanToJson } from "./repo-report.ts";
import type { ScanOutcome } from "./scan.ts";

const complete: ScanOutcome = {
  status: "complete",
  root: "./task",
  verdict: "block",
  filesScanned: 12,
  durationMs: 3.2,
  findings: [
    {
      ruleId: "repo/unscanned",
      severity: "warn",
      file: "tailwind.config.js",
      message: "too big",
    },
    {
      ruleId: "repo/lifecycle-script",
      severity: "block",
      file: "package.json",
      message: "postinstall fetches",
    },
    {
      ruleId: "repo/known-tool",
      severity: "info",
      file: "package.json",
      message: "prisma generate",
    },
  ],
};
const clean: ScanOutcome = { ...complete, verdict: "allow", findings: [] };
const incomplete: ScanOutcome = {
  status: "incomplete",
  root: "./task",
  reason: "more than 2 entries",
  durationMs: 1,
};

describe("renderScan", () => {
  it("emoji mode: verdict header, most severe first, footer", () => {
    const text = renderScan(complete, { emoji: true });
    const lines = text.split("\n");
    expect(lines[0]).toBe("🐸 croak repo ./task — 🔴 block");
    const order = ["🔴 block", "🟡 warn", "🔵 info"].map((label) =>
      text.indexOf(label),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain(
      "🔴 block  package.json  repo/lifecycle-script\n           postinstall fetches",
    );
    expect(text).toContain("12 files scanned · 3 ms");
  });

  it("plain mode: no emoji, uppercase greppable severities", () => {
    const text = renderScan(complete, { emoji: false });
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text.split("\n")[0]).toBe("croak repo ./task - BLOCK");
    expect(text).toContain("BLOCK  package.json  repo/lifecycle-script");
    expect(text).toContain("INFO   package.json  repo/known-tool");
  });

  it("says so plainly when nothing was found", () => {
    expect(renderScan(clean, { emoji: true })).toContain("🟢 allow");
    expect(renderScan(clean, { emoji: false })).toContain(
      "nothing suspicious found",
    );
  });

  it("never presents an incomplete scan as clean", () => {
    const text = renderScan(incomplete, { emoji: false });
    expect(text.split("\n")[0]).toBe("croak repo ./task - INCOMPLETE");
    expect(text).toContain("more than 2 entries");
    expect(text).toContain("not a clean scan");
    expect(renderScan(incomplete, { emoji: true })).toContain("🟠 incomplete");
  });
});

describe("hostile text in the report", () => {
  it("escapes terminal control and bidi characters from the scanned repo", () => {
    const evil: ScanOutcome = {
      ...complete,
      root: "./t\u001b]0;pwned\u0007",
      findings: [
        {
          ruleId: "repo/x",
          severity: "block",
          file: "a\u202e.js",
          message: "runs `x`\u001b[2K\u001b[1A erased",
        },
      ],
    };
    const text = renderScan(evil, { emoji: false });
    const raw = [...text].filter(
      (ch) => (ch.charCodeAt(0) < 0x20 && ch !== "\n") || ch === "\u202e",
    );
    expect(raw).toEqual([]);
    expect(text).toContain("\\u001b[2K");
    expect(text).toContain("a\\u202e.js");
  });

  it("leaves ordinary text alone", () => {
    expect(safe("plain — text, кириллица 🐸")).toBe(
      "plain — text, кириллица 🐸",
    );
  });
});

describe("verdict meaning", () => {
  it("never presents yellow or green as safe", () => {
    const warn = renderScan({ ...complete, verdict: "warn" }, { emoji: false });
    expect(warn).toContain("Needs your attention");
    expect(warn).toContain("This is not a safe verdict");
    expect(renderScan(clean, { emoji: false })).toContain("Not a guarantee");
    expect(renderScan(complete, { emoji: false })).toContain(
      "Do not install or run this",
    );
  });
});

describe("scanToJson", () => {
  it("emits a versioned, machine-readable report", () => {
    expect(JSON.parse(scanToJson(complete))).toMatchObject({
      schema: 1,
      status: "complete",
      verdict: "block",
      findings: expect.arrayContaining([
        expect.objectContaining({ ruleId: "repo/lifecycle-script" }),
      ]),
    });
    expect(JSON.parse(scanToJson(incomplete))).toMatchObject({
      schema: 1,
      status: "incomplete",
      reason: "more than 2 entries",
    });
  });
});

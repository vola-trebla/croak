// croak-invariants: pattern-data
// File contents below are detector inputs, not code (D16).
import { describe, expect, it } from "vitest";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";
import { hiddenCodeDetector } from "./hidden-code.ts";

function repo(files: Record<string, string>): RepoSnapshot {
  const entries: RepoEntry[] = Object.keys(files).map((path) => ({
    path,
    kind: "file",
    size: 1,
  }));
  return { entries, read: (path) => files[path] };
}
const pad = " ".repeat(300);
const scan = (files: Record<string, string>) => hiddenCodeDetector(repo(files));

describe("repo/hidden-code", () => {
  it("blocks offscreen code that evals decoded data", () => {
    const [finding] = scan({
      "tailwind.config.js": `module.exports = {};${pad}eval(atob("eA=="));`,
    });
    expect(finding).toMatchObject({
      ruleId: "repo/hidden-code",
      severity: "block",
      file: "tailwind.config.js",
      line: 1,
    });
    expect(finding?.message).toMatch(/offscreen.*column 321/);
    expect(finding?.message).toContain("eval");
  });

  it("blocks code below hundreds of blank lines that uses the network", () => {
    const text = `export default {};\n${"\n".repeat(200)}require("https").get("https://x.invalid");\n`;
    expect(scan({ "next.config.js": text })[0]).toMatchObject({
      severity: "block",
      line: 202,
    });
  });

  it("warns on hidden code without suspicious signals", () => {
    expect(
      scan({ "a.js": `const a = 1;${pad}const b = 2;` })[0]?.severity,
    ).toBe("warn");
  });

  it("warns on bidi controls in code and only notes them in JSON", () => {
    const code = `if (isAdmin‮) { grant(); }`;
    expect(scan({ "auth.ts": code })[0]).toMatchObject({
      severity: "warn",
      message: expect.stringContaining("bidi"),
    });
    expect(scan({ "locales/ar.json": `{"hello": "⁧مرحبا⁩"}` })[0]?.severity).toBe(
      "info",
    );
  });

  it("caps severity at warn inside node_modules", () => {
    expect(
      scan({ "node_modules/x/index.js": `x();${pad}eval(atob("eA=="));` })[0]
        ?.severity,
    ).toBe("warn");
  });

  it("only scans code and config files", () => {
    expect(
      scan({
        "README.md": `text${pad}eval(atob("eA=="))`,
        "data.csv": `a${pad}b`,
      }),
    ).toEqual([]);
  });

  it("reports at most five hits per file", () => {
    const text = Array.from(
      { length: 10 },
      (_, i) => `const a${i} = 1;${pad}x();`,
    ).join("\n");
    expect(scan({ "a.js": text })).toHaveLength(5);
  });

  it("ignores clean files", () => {
    expect(scan({ "a.js": "const a = 1;\n", "b.json": '{"a": 1}' })).toEqual(
      [],
    );
  });
});

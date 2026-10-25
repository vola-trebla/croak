import { describe, expect, it } from "vitest";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";
import { obfuscation } from "./obfuscation.ts";

function repo(files: Record<string, string>): RepoSnapshot {
  const entries: RepoEntry[] = Object.keys(files).map((path) => ({
    path,
    kind: "file",
    size: 1,
  }));
  return { entries, read: (path) => files[path] };
}
const scan = (files: Record<string, string>) => obfuscation(repo(files));

const escapes = `const s = "${"\\x41".repeat(10)}";`;
const blob = `const font = "${"QUJD".repeat(60)}";`;
const names = "const _0x1a2b = 1, _0x3c4d = 2, _0x5e6f = 3;";
const dynamic = "globalThis[key](arg);";

describe("repo/obfuscation", () => {
  it("only notes weak signals on their own, without calling them obfuscation", () => {
    expect(scan({ "icons.js": escapes })[0]).toMatchObject({
      severity: "info",
      message: expect.stringMatching(/^unusual encoding/),
    });
    expect(scan({ "font.js": blob })[0]?.severity).toBe("info");
  });

  it("does not block weak plus weak (an icon map with an embedded font)", () => {
    expect(scan({ "icons.js": `${escapes}\n${blob}` })[0]?.severity).toBe(
      "info",
    );
  });

  it("warns on one strong signal", () => {
    expect(scan({ "a.js": names })[0]?.severity).toBe("warn");
    expect(scan({ "a.js": dynamic })[0]?.severity).toBe("warn");
  });

  it("blocks a strong signal with any second signal", () => {
    expect(scan({ "a.js": `${names}\n${escapes}` })[0]?.severity).toBe("block");
    expect(scan({ "a.js": `${names}\n${dynamic}` })[0]?.severity).toBe("block");
  });

  it("blocks a weak signal with eval or decoding within a few lines", () => {
    expect(scan({ "a.js": `${blob}\neval(atob(font));` })[0]?.severity).toBe(
      "block",
    );
  });

  it("does not block a weak signal when decoding is far away in a large file (zod, esbuild)", () => {
    const far = `${escapes}\n${"const x = 1;\n".repeat(100)}const ok = atob(input);`;
    expect(scan({ "types.ts": far })[0]).toMatchObject({
      severity: "info",
      message: expect.not.stringContaining("eval"),
    });
  });

  it("is not fooled by a decoy weak line at the top of the file", () => {
    const decoy = `const icons = "${"\\x61".repeat(10)}";\n${"x();\n".repeat(49)}eval(atob("${"\\x61".repeat(10)}"));`;
    expect(scan({ "a.js": decoy })[0]?.severity).toBe("block");
  });

  it("still blocks a strong signal with decoding anywhere in the file", () => {
    expect(
      scan({ "a.js": `${names}\n${"x();\n".repeat(100)}atob(p);` })[0]
        ?.severity,
    ).toBe("block");
  });

  it("explains which signals it saw, with lines", () => {
    const [finding] = scan({ "next.config.js": `${names}\n${escapes}` });
    expect(finding).toMatchObject({
      ruleId: "repo/obfuscation",
      file: "next.config.js",
      line: 1,
    });
    expect(finding?.message).toContain("obfuscator-names (line 1)");
    expect(finding?.message).toContain("escapes (line 2)");
  });

  it("caps severity at warn inside node_modules", () => {
    expect(
      scan({ "node_modules/x/index.js": `${names}\n${escapes}` })[0]?.severity,
    ).toBe("warn");
  });

  it("only scans JS and TS files, and ignores clean ones", () => {
    expect(
      scan({
        "data.json": `{"a": "${"\\u0041".repeat(20)}"}`,
        "a.js": "const a = 1;",
      }),
    ).toEqual([]);
  });
});

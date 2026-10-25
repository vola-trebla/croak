// croak-invariants: pattern-data
// Detector patterns and test inputs below are data, not code (D16).
import { describe, expect, it } from "vitest";
import {
  type CodeSignal,
  codeSignals,
  describeSignals,
  isSuspicious,
} from "./code.ts";

const signals = (text: string): CodeSignal[] =>
  [...new Set(codeSignals(text).map((h) => h.signal))].sort();

describe("codeSignals", () => {
  it.each([
    ["fetch", `fetch("https://x.invalid", { method: "POST" })`, "network"],
    ["https module", `const https = require("https");`, "network"],
    ["node:net import", `import net from "node:net";`, "network"],
    ["axios", `import axios from "axios";`, "network"],
    ["WebSocket", `new WebSocket(url)`, "network"],
    [
      "child_process",
      `const { execSync } = require("child_process");`,
      "process",
    ],
    ["execa", `import { execa } from "execa";`, "process"],
    ["eval", `eval(payload)`, "eval"],
    ["new Function", `new Function(code)()`, "eval"],
    ["vm", `require("node:vm").runInThisContext(c)`, "eval"],
    ["atob", `atob(blob)`, "decode"],
    ["Buffer base64", `Buffer.from(s, "base64").toString()`, "decode"],
    ["fromCharCode", `String.fromCharCode(99, 114)`, "decode"],
    ["ssh dir", `fs.readFileSync(home + "/.ssh/id_rsa")`, "secrets"],
    ["npmrc", `path.join(os.homedir(), ".npmrc")`, "secrets"],
    ["whole env", `body: JSON.stringify(process.env)`, "secrets"],
    ["env keys", `Object.keys(process.env)`, "secrets"],
    ["shell rc", `appendFileSync("~/.zshrc", line)`, "secrets"],
    ["browser credentials", `join(profile, "Login Data")`, "secrets"],
    ["metamask", `const id = "nkbihfbeogaeaoehlefnkodbefgpgknn";`, "secrets"],
  ])("detects %s", (_name, text, signal) => {
    expect(signals(text)).toContain(signal);
  });

  it.each([
    ["single env var", `const port = process.env.PORT ?? 3000;`],
    ["env index", `const v = process.env[name];`],
    ["object fields", `config.ssh = true; user.profile.name = "x";`],
    ["regex exec", `const m = /a/.exec(s);`],
    ["base64 encode", `Buffer.from(s).toString("base64")`],
    ["a URL string", `const docs = "https://example.com";`],
    ["copy env example", `copyFileSync(".env.example", ".env")`],
  ])("ignores %s", (_name, text) => {
    expect(signals(text)).toEqual([]);
  });

  it("reports line numbers", () => {
    expect(codeSignals("ok\nfetch(x)\n")[0]).toMatchObject({
      signal: "network",
      line: 2,
      label: "fetch",
    });
  });
});

describe("isSuspicious", () => {
  it.each([
    [["network"], false],
    [["secrets"], false],
    [["network", "secrets"], true],
    [["network", "process"], true],
    [["network", "decode"], true],
    [["network", "eval"], true],
    [["eval", "decode"], true],
    [["eval"], false],
    [["process"], false],
  ] as const)("%j → %s", (set, expected) => {
    expect(isSuspicious(new Set(set))).toBe(expected);
  });
});

describe("describeSignals", () => {
  it("names each signal once with where it was first seen", () => {
    const text =
      "const h = require('https');\nfetch(u);\nJSON.stringify(process.env);\n";
    expect(describeSignals(codeSignals(text), "x.js")).toBe(
      "network (x.js:1), secrets (x.js:3)",
    );
  });
});

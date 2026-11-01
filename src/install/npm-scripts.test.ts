import { describe, expect, it } from "vitest";
import { npmScriptPolicy } from "./npm-scripts.ts";

const none = { allowScripts: [], allowAll: false };
const manifest = (allowScripts: unknown, extra: object = {}) =>
  JSON.stringify({ name: "app", allowScripts, ...extra });

describe("npmScriptPolicy", () => {
  it("lets only the packages the project allows run their scripts (npm 12+)", () => {
    const mayRun = npmScriptPolicy(
      manifest({ esbuild: true, "sharp@0.34.1": true, "core-js": false }),
      "12.2.1",
      none,
    );
    expect(mayRun?.("esbuild")).toBe(true);
    expect(mayRun?.("sharp")).toBe(true);
    expect(mayRun?.("core-js")).toBe(false);
    expect(mayRun?.("left-pad")).toBe(false);
  });

  it("reads scoped names, pinned or not", () => {
    const mayRun = npmScriptPolicy(
      manifest({ "@swc/core@1.11.0": true, "@prisma/engines": true }),
      "12.0.0",
      none,
    );
    expect(mayRun?.("@swc/core")).toBe(true);
    expect(mayRun?.("@prisma/engines")).toBe(true);
    expect(mayRun?.("@swc/other")).toBe(false);
  });

  it("counts npm's allow-scripts config as allowed too", () => {
    const mayRun = npmScriptPolicy(manifest({}), "12.2.1", {
      allowScripts: ["canvas", "sharp@0.34.1"],
      allowAll: false,
    });
    expect(mayRun?.("canvas")).toBe(true);
    expect(mayRun?.("sharp")).toBe(true);
    expect(mayRun?.("esbuild")).toBe(false);
  });

  it("holds every script back when the project has no allowScripts at all", () => {
    expect(npmScriptPolicy(undefined, "12.2.1", none)?.("esbuild")).toBe(false);
    expect(npmScriptPolicy('{"name":"app"}', "12.2.1", none)?.("esbuild")).toBe(
      false,
    );
  });

  it.each([
    [
      "npm 11, which runs every script",
      npmScriptPolicy(manifest({}), "11.19.1", none),
    ],
    [
      "a version croak cannot read",
      npmScriptPolicy(manifest({}), "next", none),
    ],
    [
      "dangerously-allow-all-scripts",
      npmScriptPolicy(manifest({}), "12.2.1", {
        allowScripts: [],
        allowAll: true,
      }),
    ],
    ["a broken package.json", npmScriptPolicy("{ not json", "12.2.1", none)],
    [
      "a package.json that is not an object",
      npmScriptPolicy("[]", "12.2.1", none),
    ],
    [
      "allowScripts that is not an object",
      npmScriptPolicy(manifest(["esbuild"]), "12.2.1", none),
    ],
    [
      "a value that is not true or false",
      npmScriptPolicy(manifest({ esbuild: "yes" }), "12.2.1", none),
    ],
    [
      "a pattern croak does not expand",
      npmScriptPolicy(manifest({ "@scope/*": true }), "12.2.1", none),
    ],
    [
      "a pin to another npm",
      npmScriptPolicy(
        manifest({}, { packageManager: "npm@11.19.1" }),
        "12.2.1",
        none,
      ),
    ],
    [
      "a devEngines pin to another npm",
      npmScriptPolicy(
        manifest(
          {},
          {
            devEngines: { packageManager: { name: "npm", version: "11.19.1" } },
          },
        ),
        "12.2.1",
        none,
      ),
    ],
  ])("is unsure, so it changes nothing, with %s", (_why, mayRun) => {
    expect(mayRun).toBeUndefined();
  });

  it("accepts a pin to exactly the npm croak measured", () => {
    expect(
      npmScriptPolicy(
        manifest({}, { packageManager: "npm@12.2.1+sha512.abc" }),
        "12.2.1",
        none,
      )?.("esbuild"),
    ).toBe(false);
  });
});

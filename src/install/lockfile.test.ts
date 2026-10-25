import { describe, expect, it } from "vitest";
import { LockfileError, parseLockfile } from "./lockfile.ts";

const lock = (packages: Record<string, object>, lockfileVersion = 3) =>
  JSON.stringify({
    name: "app",
    lockfileVersion,
    requires: true,
    packages: { "": { name: "app" }, ...packages },
  });

describe("parseLockfile", () => {
  it("reads packages, names from paths, nested and scoped", () => {
    const parsed = parseLockfile(
      lock({
        "node_modules/lodash": {
          version: "4.17.21",
          resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
          integrity: "sha512-x",
        },
        "node_modules/@scope/pkg": { version: "1.0.0", hasInstallScript: true },
        "node_modules/a/node_modules/b": { version: "2.0.0", dev: true },
      }),
    );
    expect(parsed.map((e) => `${e.name}@${e.version}`)).toEqual([
      "lodash@4.17.21",
      "@scope/pkg@1.0.0",
      "b@2.0.0",
    ]);
    expect(parsed[1]).toMatchObject({
      hasInstallScript: true,
      path: "node_modules/@scope/pkg",
    });
    expect(parsed[2]).toMatchObject({ dev: true });
  });

  it("skips the root entry and keeps workspace links as links", () => {
    const parsed = parseLockfile(
      lock({
        "node_modules/ws-pkg": { resolved: "packages/ws-pkg", link: true },
      }),
    );
    expect(parsed).toEqual([
      expect.objectContaining({ name: "ws-pkg", link: true }),
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    expect(parseLockfile(`﻿${lock({})}`)).toEqual([]);
  });

  it.each([
    ["invalid JSON", "{ nope"],
    [
      "lockfile v1 (no packages map)",
      JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
    ],
    [
      "a non-object package entry",
      lock({ "node_modules/x": "1.0.0" as unknown as object }),
    ],
  ])("rejects %s", (_name, text) => {
    expect(() => parseLockfile(text)).toThrow(LockfileError);
  });
});

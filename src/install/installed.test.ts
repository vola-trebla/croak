import { describe, expect, it } from "vitest";
import { installedLockfile } from "./installed.ts";

const hidden = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    "node_modules/is-number": { version: "7.0.0" },
    "node_modules/@s/b": { version: "1.0.0" },
    "node_modules/gone": { version: "2.0.0" },
    "node_modules/other": { version: "3.0.0" },
  },
});
const disk: Record<string, string> = {
  "/p/node_modules/.package-lock.json": hidden,
  "/p/node_modules/is-number/package.json":
    '{"name":"is-number","version":"7.0.0"}',
  "/p/node_modules/@s/b/package.json": '{"name":"@s/b","version":"1.0.0"}',
  "/p/node_modules/other/package.json": '{"name":"other","version":"9.9.9"}',
};
const packagesOf = (text: string | undefined) =>
  Object.keys(JSON.parse(text ?? "{}").packages ?? {});

describe("installedLockfile", () => {
  it("keeps only entries whose folder has the same name and version", () => {
    expect(packagesOf(installedLockfile("/p", (path) => disk[path]))).toEqual([
      "",
      "node_modules/is-number",
      "node_modules/@s/b",
    ]);
  });

  it("does not trust a committed hidden lockfile without the package folders", () => {
    const forged = { "/p/node_modules/.package-lock.json": hidden };
    expect(
      packagesOf(
        installedLockfile("/p", (path) => forged[path as keyof typeof forged]),
      ),
    ).toEqual([""]);
  });

  it("is undefined when nothing is installed or the file is unreadable", () => {
    expect(installedLockfile("/p", () => undefined)).toBeUndefined();
    expect(installedLockfile("/p", () => "not json")).toBeUndefined();
  });
});

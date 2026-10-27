import { describe, expect, it } from "vitest";
import { installedLockfile, installedPnpmLockfile } from "./installed.ts";
import { parsePnpmLockfile } from "./pnpm-lockfile.ts";

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

describe("installedPnpmLockfile", () => {
  const hidden = [
    "lockfileVersion: '9.0'",
    "packages:",
    "  is-number@7.0.0:",
    "    resolution: {integrity: sha512-a==}",
    "  react-dom@19.2.0:",
    "    resolution: {integrity: sha512-b==}",
    "  '@s/b@1.0.0':",
    "    resolution: {integrity: sha512-c==}",
    "  gone@2.0.0:",
    "    resolution: {integrity: sha512-d==}",
  ].join("\n");
  const store = "/p/node_modules/.pnpm";
  const disk: Record<string, string> = {
    [`${store}/lock.yaml`]: hidden,
    [`${store}/is-number@7.0.0/node_modules/is-number/package.json`]:
      '{"name":"is-number","version":"7.0.0"}',
    [`${store}/react-dom@19.2.0_react@19.3.1/node_modules/react-dom/package.json`]:
      '{"name":"react-dom","version":"19.2.0"}',
    [`${store}/@s+b@1.0.0/node_modules/@s/b/package.json`]:
      '{"name":"@s/b","version":"1.0.0"}',
  };
  const folders = [
    "is-number@7.0.0",
    "react-dom@19.2.0_react@19.3.1",
    "@s+b@1.0.0",
    "node_modules",
  ];
  const names = (text: string | undefined) =>
    Object.values(JSON.parse(text ?? "{}").packages ?? {})
      .map((e) => (e as { name?: string }).name)
      .filter(Boolean);

  it("keeps entries whose store folder holds that package, peer suffixes and scopes included", () => {
    expect(
      names(
        installedPnpmLockfile(
          "/p",
          (path) => disk[path],
          () => folders,
          parsePnpmLockfile,
        ),
      ),
    ).toEqual(["is-number", "react-dom", "@s/b"]);
  });

  it("does not trust a hidden lockfile without its folders", () => {
    const forged: Record<string, string> = { [`${store}/lock.yaml`]: hidden };
    expect(
      names(
        installedPnpmLockfile(
          "/p",
          (path) => forged[path],
          () => [],
          parsePnpmLockfile,
        ),
      ),
    ).toEqual([]);
  });

  it("is undefined when pnpm installed nothing", () => {
    expect(
      installedPnpmLockfile(
        "/p",
        () => undefined,
        () => [],
        parsePnpmLockfile,
      ),
    ).toBeUndefined();
  });
});

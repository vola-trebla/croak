import { describe, expect, it } from "vitest";
import { LockfileError } from "./lockfile.ts";
import { isPnpmLockfile, parsePnpmLockfile } from "./pnpm-lockfile.ts";

// Trimmed from a lockfile pnpm 12 wrote for esbuild, @isaacs/cliui, react-dom and an npm: alias.
const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      esbuild:
        specifier: 0.28.2
        version: 0.28.2
      react-dom:
        specifier: 19.2.0
        version: 19.2.0(react@19.3.1)
      sw:
        specifier: npm:string-width@4.2.3
        version: string-width@4.2.3

packages:

  '@esbuild/darwin-arm64@0.28.2':
    resolution: {integrity: sha512-n4Kq==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [darwin]

  esbuild@0.28.2:
    resolution: {integrity: sha512-HKVL==}
    engines: {node: '>=18'}
    hasBin: true

  react-dom@19.2.0:
    resolution: {integrity: sha512-Ulb==}
    peerDependencies:
      react: ^19.2.0

  string-width@4.2.3:
    resolution: {integrity: sha512-wKy==}

  gitdep@https://codeload.github.com/o/r/tar.gz/abc:
    resolution: {tarball: https://codeload.github.com/o/r/tar.gz/abc}
    version: 1.0.0

  local@file:packages/local:
    resolution: {directory: packages/local, type: directory}

  forked@git+https://github.com/o/forked.git#abc123:
    resolution: {type: git, repo: https://github.com/o/forked.git, commit: abc123}
    version: 2.0.0

snapshots:

  '@esbuild/darwin-arm64@0.28.2':
    optional: true

  esbuild@0.28.2:
    optionalDependencies:
      '@esbuild/darwin-arm64': 0.28.2

  react-dom@19.2.0(react@19.3.1):
    dependencies:
      react: 19.3.1
    transitivePeerDependencies:
      - scheduler
`;

describe("parsePnpmLockfile", () => {
  const entries = parsePnpmLockfile(LOCK);
  const byName = (name: string) => entries.find((e) => e.name === name);

  it("derives the registry tarball URL from name and version", () => {
    expect(byName("esbuild")).toMatchObject({
      version: "0.28.2",
      resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz",
      integrity: "sha512-HKVL==",
      link: false,
    });
    expect(byName("@esbuild/darwin-arm64")).toMatchObject({
      resolved:
        "https://registry.npmjs.org/@esbuild/darwin-arm64/-/darwin-arm64-0.28.2.tgz",
      os: ["darwin"],
      cpu: ["arm64"],
      optional: true,
    });
  });

  it("keeps the real name behind an npm: alias", () => {
    expect(byName("string-width")?.resolved).toBe(
      "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz",
    );
  });

  it("keeps git and tarball sources, and treats a local directory as a link", () => {
    expect(byName("gitdep")).toMatchObject({
      resolved: "https://codeload.github.com/o/r/tar.gz/abc",
      version: "1.0.0",
    });
    expect(byName("forked")).toMatchObject({
      resolved: "git+https://github.com/o/forked.git#abc123",
      version: "2.0.0",
    });
    expect(byName("local")).toMatchObject({ link: true, resolved: undefined });
  });

  it("reads every document of a lockfile with a pnpm self-management part", () => {
    const env =
      "---\nlockfileVersion: '9.0'\n\nimporters:\n  .:\n    configDependencies: {}\n\npackages:\n  pnpm@12.4.2:\n    resolution: {integrity: sha512-p==}\n\n---\n";
    expect(parsePnpmLockfile(env + LOCK).map((e) => e.name)).toContain("pnpm");
  });

  it("is a LockfileError for other lockfile versions and for YAML croak does not read", () => {
    expect(() => parsePnpmLockfile("lockfileVersion: '6.0'\n")).toThrow(
      /not supported/,
    );
    expect(() =>
      parsePnpmLockfile("lockfileVersion: '9.0'\npackages: &a\n"),
    ).toThrow(LockfileError);
  });

  it("tells a pnpm lockfile from an npm one", () => {
    expect(isPnpmLockfile(LOCK)).toBe(true);
    expect(isPnpmLockfile('{"lockfileVersion": 3}')).toBe(false);
  });
});

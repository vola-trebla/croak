import { describe, expect, it } from "vitest";
import {
  SanitizeError,
  sanitizePnpmWorkspace,
  sanitizeRootManifest,
} from "./sanitize.ts";

describe("sanitizeRootManifest", () => {
  it("drops the fields that make corepack fetch and run a package manager", () => {
    const out = JSON.parse(
      sanitizeRootManifest(
        '{"name":"app","packageManager":"pnpm@9.15.0","devEngines":{"packageManager":{"name":"pnpm"}},"dependencies":{"a":"1"}}',
      ),
    );
    expect(out).toEqual({ name: "app", dependencies: { a: "1" } });
  });

  it("keeps only resolution settings in the manifest's pnpm field", () => {
    const out = JSON.parse(
      sanitizeRootManifest(
        '{"pnpm":{"overrides":{"a":"1"},"patchedDependencies":{"x":"p.patch"},"onlyBuiltDependencies":["esbuild"]}}',
      ),
    );
    expect(out).toEqual({ pnpm: { overrides: { a: "1" } } });
  });

  it("refuses a manifest it cannot read", () => {
    expect(() => sanitizeRootManifest("{ nope")).toThrow(SanitizeError);
  });
});

describe("sanitizePnpmWorkspace", () => {
  it("keeps what shapes resolution and drops what loads code or moves the registry", () => {
    const yaml = [
      "packages:",
      "  - packages/*",
      "catalog:",
      "  react: ^19.2.0",
      "autoInstallPeers: false",
      "configDependencies:",
      "  evil-config: 1.0.0+sha512-x",
      "pnpmfile: .pnpmfile.cjs",
      "registry: https://attacker.invalid/",
      "patchedDependencies:",
      "  x: patches/x.patch",
      "allowBuilds:",
      "  esbuild: true",
    ].join("\n");
    expect(JSON.parse(sanitizePnpmWorkspace(yaml))).toEqual({
      packages: ["packages/*"],
      catalog: { react: "^19.2.0" },
      autoInstallPeers: false,
    });
  });

  it("refuses YAML it cannot read", () => {
    expect(() => sanitizePnpmWorkspace("packages: &x")).toThrow(SanitizeError);
  });
});

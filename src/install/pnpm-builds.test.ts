import { describe, expect, it } from "vitest";
import type { Finding } from "../verdict.ts";
import { applyBuildPolicy, pnpmBuildPolicy } from "./pnpm-builds.ts";

const policy = (
  workspaceYaml?: string,
  packageJson?: string,
  version = "12.4.2",
) => pnpmBuildPolicy({ packageJson, workspaceYaml }, version);

describe("pnpmBuildPolicy", () => {
  it("lets only the packages the project names run their scripts (pnpm 10+)", () => {
    const allowed = policy(
      "allowBuilds:\n  esbuild: true\n  core-js: false\n  nx@21.6.4 || 21.6.5: true\n",
    );
    expect(allowed?.("esbuild")).toBe(true);
    expect(allowed?.("nx")).toBe(true);
    expect(allowed?.("core-js")).toBe(true); // named, even as false: not croak's call to downgrade
    expect(allowed?.("sharp")).toBe(false);
  });

  it("counts every script when the project pins another pnpm (M6 review)", () => {
    const ws = "allowBuilds: {}\n";
    expect(policy(ws, '{"packageManager":"pnpm@9.15.4"}')).toBeUndefined();
    expect(
      policy(ws, '{"packageManager":"pnpm@12.4.2+sha512.abc"}')?.("esbuild"),
    ).toBe(false);
    expect(policy(ws, '{"packageManager":"yarn@4.0.0"}')).toBeUndefined();
    expect(
      policy(
        ws,
        '{"devEngines":{"packageManager":{"name":"pnpm","version":"^9"}}}',
      ),
    ).toBeUndefined();
  });

  it("reads a name with a trailing comment as the name (M6 review)", () => {
    expect(
      policy(
        "onlyBuiltDependencies:\n  - esbuild # for vite\n",
        undefined,
        "10.4.0",
      )?.("esbuild"),
    ).toBe(true);
  });

  it("reads pnpm 10's onlyBuiltDependencies, in pnpm-workspace.yaml or package.json", () => {
    expect(
      policy(
        "onlyBuiltDependencies:\n  - esbuild\n",
        undefined,
        "10.4.0",
      )?.("esbuild"),
    ).toBe(true);
    expect(
      policy(
        undefined,
        '{"pnpm":{"onlyBuiltDependencies":["sharp"]}}',
        "10.4.0",
      )?.("sharp"),
    ).toBe(true);
    expect(
      policy(
        undefined,
        '{"pnpm":{"onlyBuiltDependencies":["sharp"]}}',
        "10.4.0",
      )?.("esbuild"),
    ).toBe(false);
  });

  it.each([
    ["pnpm older than 10", policy("allowBuilds: {}\n", undefined, "9.15.0")],
    ["allow every build", policy("dangerouslyAllowAllBuilds: true\n")],
    [
      "allow every build, with a comment",
      policy("dangerouslyAllowAllBuilds: true # ok\n"),
    ],
    [
      "allow every build, capitalised",
      policy("dangerouslyAllowAllBuilds: True\n"),
    ],
    [
      "a list in another file",
      policy("onlyBuiltDependenciesFile: builds.json\n"),
    ],
    ["a glob", policy("allowBuilds:\n  '@scope/*': true\n")],
    ["a settings file croak cannot read", policy("allowBuilds: &x\n")],
    ["a broken package.json", policy(undefined, "{ not json")],
  ])("counts every script as running with %s", (_name, result) => {
    expect(result).toBeUndefined();
  });
});

describe("applyBuildPolicy", () => {
  const finding = (
    file: string,
    severity: Finding["severity"],
    ruleId = "repo/lifecycle-script",
  ): Finding => ({
    ruleId,
    severity,
    file,
    message: "postinstall runs node install.js",
  });
  const policyFn = (name: string) => name === "esbuild";

  it("turns warnings about scripts pnpm will not run into info, and keeps the rest", () => {
    const out = applyBuildPolicy(
      [
        finding("sharp@0.34.0/package.json", "warn"),
        finding("esbuild@0.28.2/package.json", "warn"),
        finding("evil@1.0.0/package.json", "block"),
        finding("sharp@0.34.0", "warn", "install/recent-release"),
      ],
      policyFn,
    );
    expect(out.map((f) => `${f.severity}:${f.file}:${f.ruleId}`)).toEqual([
      "info:sharp@0.34.0/package.json:repo/lifecycle-script",
      "warn:esbuild@0.28.2/package.json:repo/lifecycle-script",
      "block:evil@1.0.0/package.json:repo/lifecycle-script",
      "warn:sharp@0.34.0:install/recent-release",
    ]);
    expect(out[0]?.message).toContain("pnpm will not run it");
  });
});

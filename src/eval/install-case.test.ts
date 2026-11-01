import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkInstallFixture, InstallFixtureError } from "./install-case.ts";

const fixture = (id: string) =>
  join(import.meta.dirname, "../../eval/cases", id, "fixture");

describe("checkInstallFixture", () => {
  it("fills in registry URLs and integrity, so a clean package verifies", async () => {
    expect(
      await checkInstallFixture(fixture("benign-popular-package")),
    ).toMatchObject({ status: "complete", verdict: "allow" });
  });

  it("keeps an integrity the fixture states (tampered tarball)", async () => {
    const outcome = await checkInstallFixture(fixture("a-tampered-tarball"));
    // The registry signed the real tarball's hash, not the lockfile's.
    expect(outcome.status === "complete" && outcome.findings).toEqual([
      expect.objectContaining({
        ruleId: "install/signature",
        severity: "block",
      }),
      expect.objectContaining({ ruleId: "install/integrity" }),
    ]);
  });

  it("diffs against before.package-lock.json when the fixture has one", async () => {
    const outcome = await checkInstallFixture(
      fixture("a-new-fresh-dependency"),
    );
    expect(outcome).toMatchObject({ status: "complete", added: 1, changed: 1 });
  });

  it("plans as npm 12 when the fixture pins it, reading allowScripts (D56)", async () => {
    const severity = async (id: string) => {
      const outcome = await checkInstallFixture(fixture(id));
      return (
        outcome.status === "complete" &&
        outcome.findings.find((f) => f.ruleId === "repo/lifecycle-script")
          ?.severity
      );
    };
    expect(await severity("benign-binary-installer")).toBe("warn");
    expect(await severity("benign-npm-unapproved-script")).toBe("info");
    expect(await severity("benign-npm-approved-script")).toBe("warn");
    expect(await severity("a-npm-unapproved-script-exfil")).toBe("block");
  });

  it("rejects a fixture without a lockfile", async () => {
    await expect(checkInstallFixture(fixture("d-postinstall"))).rejects.toThrow(
      InstallFixtureError,
    );
  });
});

describe("checkInstallFixture with pnpm-lock.yaml", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });
  /** A temporary fixture: path → content. */
  const make = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "croak-pnpm-fixture-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  };
  const lock = (version: string) =>
    [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "  .:",
      "    dependencies:",
      "      nodebridge:",
      `        specifier: ^${version}`,
      `        version: ${version}`,
      "",
      "packages:",
      `  nodebridge@${version}:`,
      "    resolution: {}",
      "",
      "snapshots:",
      `  nodebridge@${version}: {}`,
      "",
    ].join("\n");
  const packument = (scripts: string) =>
    JSON.stringify({
      name: "nodebridge",
      time: {
        created: "2021-11-20T00:00:00.000Z",
        "6.0.0": "2026-06-27T00:00:00.000Z",
        "6.0.1": "2026-10-05T00:00:00.000Z",
      },
      versions: Object.fromEntries(
        ["6.0.0", "6.0.1"].map((v) => [
          v,
          {
            name: "nodebridge",
            version: v,
            _npmUser: { name: "ana" },
            dist: {},
            ...(scripts === "" ? {} : { scripts: { postinstall: scripts } }),
          },
        ]),
      ),
    });
  const installer = {
    "packages/nodebridge@6.0.1/package.json": JSON.stringify({
      name: "nodebridge",
      version: "6.0.1",
      scripts: { postinstall: "node setup.js" },
    }),
    // The esbuild-style installer of the benign-binary-installer case.
    "packages/nodebridge@6.0.1/setup.js": readFileSync(
      join(
        fixture("benign-binary-installer"),
        "packages/nodebridge@6.0.1/setup.js",
      ),
      "utf8",
    ),
    "registry/nodebridge.json": packument("node setup.js"),
  };

  it("fills in each resolution's integrity, so a clean package verifies", async () => {
    const dir = make({
      "pnpm-lock.yaml": lock("6.0.1"),
      "packages/nodebridge@6.0.1/index.js": "module.exports = 1;",
      "registry/nodebridge.json": packument(""),
    });
    expect(await checkInstallFixture(dir)).toMatchObject({
      status: "complete",
      verdict: "allow",
      added: 1,
    });
  });

  it("diffs against before.pnpm-lock.yaml when the fixture has one", async () => {
    const dir = make({
      "pnpm-lock.yaml": lock("6.0.1"),
      "before.pnpm-lock.yaml": lock("6.0.0"),
      "packages/nodebridge@6.0.1/index.js": "module.exports = 1;",
      "registry/nodebridge.json": packument(""),
    });
    expect(await checkInstallFixture(dir)).toMatchObject({
      status: "complete",
      added: 0,
      changed: 1,
    });
  });

  it("applies pnpm's build rule: a script the project does not allow is info", async () => {
    const outcome = await checkInstallFixture(
      make({ "pnpm-lock.yaml": lock("6.0.1"), ...installer }),
    );
    expect(outcome).toMatchObject({ status: "complete", verdict: "allow" });
    expect(outcome.status === "complete" && outcome.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "repo/lifecycle-script",
        severity: "info",
      }),
    );
  });

  it("reads the build rule from pnpm-workspace.yaml and package.json", async () => {
    for (const allow of [
      { "pnpm-workspace.yaml": "allowBuilds:\n  nodebridge: true\n" },
      {
        "package.json": JSON.stringify({
          name: "app",
          pnpm: { onlyBuiltDependencies: ["nodebridge"] },
        }),
      },
    ]) {
      const outcome = await checkInstallFixture(
        make({ "pnpm-lock.yaml": lock("6.0.1"), ...installer, ...allow }),
      );
      expect(outcome).toMatchObject({ status: "complete", verdict: "warn" });
      expect(outcome.status === "complete" && outcome.findings).toContainEqual(
        expect.objectContaining({
          ruleId: "repo/lifecycle-script",
          severity: "warn",
        }),
      );
    }
  });

  it("rejects a fixture with both an npm and a pnpm lockfile", async () => {
    const dir = make({
      "pnpm-lock.yaml": lock("6.0.1"),
      "package-lock.json": "{}",
    });
    await expect(checkInstallFixture(dir)).rejects.toThrow(
      /both package-lock.json and pnpm-lock.yaml/,
    );
  });
});

describe("checkInstallFixture with the project's own files", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });
  const make = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "croak-project-fixture-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  };
  // The fake test assignment's exfil script of the d-postinstall-exfil case.
  const exfil = readFileSync(
    join(
      import.meta.dirname,
      "../../eval/cases/d-postinstall-exfil/fixture/scripts/setup.js",
    ),
    "utf8",
  );
  const npmLock = (members: Record<string, unknown> = {}) =>
    JSON.stringify({
      name: "app",
      lockfileVersion: 3,
      packages: { "": { name: "app", version: "1.0.0" }, ...members },
    });
  const findings = async (dir: string) => {
    const outcome = await checkInstallFixture(dir);
    if (outcome.status !== "complete") throw new Error(outcome.reason);
    return outcome;
  };

  it("checks the root package.json's install scripts, as a plain npm install runs them", async () => {
    const outcome = await findings(
      make({
        "package-lock.json": npmLock(),
        "package.json": JSON.stringify({
          name: "app",
          scripts: { postinstall: "node scripts/setup.js" },
        }),
        "scripts/setup.js": exfil,
      }),
    );
    expect(outcome.verdict).toBe("block");
    expect(outcome.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "repo/lifecycle-script",
        severity: "block",
        file: "package.json",
      }),
    );
  });

  it("checks the install scripts of the workspace members the lockfile lists", async () => {
    const outcome = await findings(
      make({
        "package-lock.json": npmLock({
          "apps/web": { name: "web", version: "1.0.0" },
          "node_modules/web": { resolved: "apps/web", link: true },
        }),
        "package.json": JSON.stringify({
          name: "app",
          workspaces: ["apps/*"],
        }),
        "apps/web/package.json": JSON.stringify({
          name: "web",
          scripts: { preinstall: "node setup.js" },
        }),
        "apps/web/setup.js": exfil,
      }),
    );
    expect(outcome.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "repo/lifecycle-script",
        severity: "block",
        file: "apps/web/package.json",
      }),
    );
  });

  it("checks a pnpm project's pnpmfile, which pnpm runs on every install", async () => {
    const outcome = await findings(
      make({
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
        "package.json": JSON.stringify({ name: "app" }),
        ".pnpmfile.cjs": exfil,
      }),
    );
    expect(outcome.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "repo/pnpmfile",
        severity: "block",
        file: ".pnpmfile.cjs",
      }),
    );
  });

  it("adds nothing for a fixture without the project's package.json", async () => {
    const outcome = await findings(
      make({
        "package-lock.json": npmLock(),
        "scripts/setup.js": exfil,
        ".pnpmfile.cjs": exfil,
      }),
    );
    expect(outcome).toMatchObject({ verdict: "allow", findings: [] });
  });
});

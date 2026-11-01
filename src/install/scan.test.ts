// croak-invariants: pattern-data
// Package contents below are detector inputs, not code (D16).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LlmError } from "../llm/triage.ts";
import type { Finding } from "../verdict.ts";
import type { ContentCache } from "./content-cache.ts";
import { planInstall, planInstallOnline } from "./scan.ts";
import { signPackument, TEST_REGISTRY_KEY } from "./test-registry.ts";
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

  it("notes a workspace member once, not again for its node_modules link", () => {
    const outcome = planInstall(
      undefined,
      lock({
        "packages/w": { name: "w", version: "1.0.0" },
        "node_modules/w": { resolved: "packages/w", link: true },
      }),
    );
    expect(
      outcome.status === "complete" &&
        outcome.findings.map((f) => `${f.ruleId} ${f.file}`),
    ).toEqual(["install/source w@1.0.0"]);
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

  it("warns when a registry tarball URL belongs to another package (whole-project review)", () => {
    const outcome = planInstall(
      undefined,
      lock({
        "node_modules/evil": {
          name: "lodash",
          version: "4.17.21",
          resolved: "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz",
          integrity: "sha512-x",
        },
        "node_modules/string-width-cjs": {
          name: "string-width",
          version: "4.2.3",
          resolved:
            "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz",
          integrity: "sha512-y",
        },
      }),
    );
    expect(outcome.status === "complete" && outcome.findings).toEqual([
      expect.objectContaining({
        ruleId: "install/source",
        file: "lodash@4.17.21",
        message: expect.stringContaining("another package"),
      }),
    ]);
  });

  it("is incomplete, never clean, when a lockfile cannot be read", () => {
    expect(planInstall(before, "{ nope")).toMatchObject({
      status: "incomplete",
      reason: expect.stringContaining("after"),
    });
  });
});

describe("planInstall on a pnpm lockfile (M6)", () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      is-number:",
    "        specifier: 7.0.0",
    "        version: 7.0.0",
    "packages:",
    "  is-number@7.0.0:",
    "    resolution: {integrity: sha512-a==}",
    "  forked@git+https://github.com/o/forked.git#abc:",
    "    resolution: {type: git, repo: https://github.com/o/forked.git, commit: abc}",
    "    version: 2.0.0",
  ].join("\n");

  it("reads it like an npm lockfile: registry packages clean, git sources reported", () => {
    const outcome = planInstall(undefined, lock);
    expect(outcome).toMatchObject({ status: "complete", added: 2 });
    expect(
      outcome.status === "complete" &&
        outcome.findings.map((f) => `${f.ruleId}:${f.file}`),
    ).toEqual([
      "install/source:forked@2.0.0",
      "install/integrity:forked@2.0.0",
    ]);
  });

  it("is incomplete for a pnpm lockfile it cannot read", () => {
    expect(planInstall(undefined, "lockfileVersion: '6.0'\n")).toMatchObject({
      status: "incomplete",
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
      b: JSON.stringify(
        signPackument(
          JSON.parse(
            doc(
              "b",
              {
                "1.0.0": { _npmUser: { name: "x" } },
                "2.0.0": { _npmUser: { name: "mallory" } },
              },
              {
                "1.0.0": "2025-01-01T00:00:00Z",
                "2.0.0": "2026-10-24T00:00:00Z",
              },
            ),
          ),
          () => "sha512-abc",
        ),
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
      registryKeys: [TEST_REGISTRY_KEY],
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

describe("planInstallOnline: nothing falls between the checks", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  const check = (resolved: string) =>
    planInstallOnline(
      undefined,
      lock({
        "node_modules/p": { version: "1.0.0", resolved, integrity: "sha512-x" },
      }),
      {
        fetch: async () => new Response("", { status: 404 }),
        now,
        content: false,
      },
    );

  it.each([
    "https://user:pw@registry.npmjs.org/p/-/p-1.0.0.tgz",
    "https://registry.npmjs.org:8443/p/-/p-1.0.0.tgz",
  ])(
    "warns on a lookalike registry URL instead of skipping it: %s",
    async (resolved) => {
      const outcome = await check(resolved);
      expect(outcome.status === "complete" && outcome.findings).toEqual([
        expect.objectContaining({ ruleId: "install/source", severity: "warn" }),
      ]);
    },
  );

  it("checks a registry URL written in capitals online", async () => {
    const outcome = await check("HTTPS://REGISTRY.NPMJS.ORG/p/-/p-1.0.0.tgz");
    expect(outcome.status === "complete" && outcome.findings).toEqual([
      expect.objectContaining({ ruleId: "install/registry" }),
    ]);
  });

  it("is incomplete for an entry without a version", async () => {
    const outcome = await planInstallOnline(
      undefined,
      lock({
        "node_modules/p": { resolved: "https://registry.npmjs.org/p/-/p.tgz" },
      }),
      { fetch: async () => new Response("", { status: 404 }), now },
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      reason: expect.stringContaining("no version"),
    });
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
    expect(
      outcome.status === "complete" &&
        outcome.findings.find((f) => f.ruleId === "install/integrity"),
    ).toMatchObject({ severity: "block" });
  });

  it("does not check platform packages npm will not install here", async () => {
    const urls: string[] = [];
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/p": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/p/-/p-1.0.0.tgz",
          integrity: "sha512-x",
          os: ["win32"],
          cpu: ["x64"],
          optional: true,
        },
      },
    });
    const outcome = await planInstallOnline(undefined, lockfile, {
      fetch: async (input) => {
        urls.push(String(input));
        return new Response("{}", { status: 200 });
      },
      now,
      platform: { os: "darwin", cpu: "arm64" },
    });
    expect(urls).toEqual([]);
    expect(outcome).toMatchObject({ status: "complete", verdict: "allow" });
    expect(outcome.status === "complete" && outcome.findings).toEqual([
      expect.objectContaining({
        ruleId: "install/other-platform",
        severity: "info",
        message: expect.stringContaining("darwin-arm64"),
      }),
    ]);
  });

  it("names pnpm-lock.yaml for platform packages pnpm will not install here", async () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      p:",
      "        specifier: 1.0.0",
      "        version: 1.0.0",
      "packages:",
      "  p@1.0.0:",
      "    resolution: {integrity: sha512-a==}",
      "    os: [win32]",
      "    cpu: [x64]",
    ].join("\n");
    const outcome = await planInstallOnline(undefined, lock, {
      fetch: async () => new Response("{}", { status: 200 }),
      now,
      platform: { os: "darwin", cpu: "arm64" },
    });
    expect(outcome.status === "complete" && outcome.findings).toEqual([
      expect.objectContaining({
        ruleId: "install/other-platform",
        file: "pnpm-lock.yaml",
      }),
    ]);
  });

  it("reuses cached content findings instead of downloading again", async () => {
    const tgz = tarball({
      "package.json": JSON.stringify({
        name: "p",
        scripts: { postinstall: "node s.js" },
      }),
      "s.js": "fetch(u, { body: JSON.stringify(process.env) });",
    });
    const stored = new Map<string, Finding[]>();
    const cache = {
      get: (integrity: string) => stored.get(integrity),
      set: (
        integrity: string,
        _label: string,
        findings: readonly Finding[],
      ) => {
        stored.set(integrity, [...findings]);
      },
    };
    const downloads = { count: 0 };
    const counting: typeof fetch = async (input, init) => {
      if (String(input).endsWith(".tgz")) downloads.count += 1;
      return serve(tgz)(input, init);
    };
    const first = await planInstallOnline(undefined, planWith(sri(tgz)), {
      fetch: counting,
      now,
      cache,
    });
    const second = await planInstallOnline(undefined, planWith(sri(tgz)), {
      fetch: counting,
      now,
      cache,
    });
    expect(downloads.count).toBe(1);
    expect(second).toMatchObject({ status: "complete", verdict: "block" });
    expect(second.status === "complete" && second.findings).toEqual(
      first.status === "complete" && first.findings,
    );
  });

  it("never caches a tarball that failed its integrity check", async () => {
    const tgz = tarball({ "package.json": "{}" });
    const stored = new Map<string, Finding[]>();
    const cache = {
      get: () => undefined,
      set: (i: string, _l: string, f: readonly Finding[]) =>
        void stored.set(i, [...f]),
    };
    await planInstallOnline(undefined, planWith(sri(Buffer.from("other"))), {
      fetch: serve(tgz),
      now,
      cache,
    });
    expect(stored.size).toBe(0);
  });

  describe("with the opt-in LLM step (D36)", () => {
    const installer = tarball({
      "package.json": JSON.stringify({
        name: "p",
        scripts: { postinstall: "node install.js" },
      }),
      "install.js":
        'const https = require("https");\nconst cp = require("child_process");\nhttps.get(url, () => cp.execFileSync("./bin"));',
    });
    const llm = (verdict: "benign" | "malicious" | Error) => {
      const asked: string[] = [];
      return {
        asked,
        options: {
          model: "fake-model",
          triage: async (input: { label: string; diff: string }) => {
            asked.push(input.label);
            if (verdict instanceof Error) throw verdict;
            return {
              judgement: {
                label: input.label,
                verdict,
                reason: "fake",
                model: "fake-model",
              },
              inputTokens: 10,
              outputTokens: 1,
              costUsd: 0.0002,
            };
          },
        },
      };
    };

    it("asks about a warned package and lets a malicious answer block it", async () => {
      const { asked, options } = llm("malicious");
      const outcome = await planInstallOnline(
        undefined,
        planWith(sri(installer)),
        { fetch: serve(installer), now, llm: options },
      );
      expect(asked).toEqual(["p@1.0.0"]);
      expect(outcome).toMatchObject({
        status: "complete",
        verdict: "block",
        llm: { model: "fake-model", calls: 1, costUsd: 0.0002 },
      });
    });

    it("diffs a new dependency as a whole and an update against the project's version (M5 review)", async () => {
      const seen: (string | undefined)[] = [];
      const options = {
        model: "fake-model",
        triage: async (input: {
          label: string;
          previousVersion: string | undefined;
        }) => {
          seen.push(input.previousVersion);
          return {
            judgement: {
              label: input.label,
              verdict: "benign" as const,
              reason: "",
              model: "m",
            },
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0,
          };
        },
      };
      await planInstallOnline(undefined, planWith(sri(installer)), {
        fetch: serve(installer),
        now,
        llm: options,
      });
      const before = JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/p": {
            version: "0.9.0",
            resolved: "https://registry.npmjs.org/p/-/p-0.9.0.tgz",
            integrity: "sha512-old",
          },
        },
      });
      await planInstallOnline(before, planWith(sri(installer)), {
        fetch: serve(installer),
        now,
        llm: options,
      });
      expect(seen).toEqual([undefined, "0.9.0"]);
    });

    it("stays within its limits and says what it skipped (M5 review)", async () => {
      const { asked, options } = llm("malicious");
      const outcome = await planInstallOnline(
        undefined,
        planWith(sri(installer)),
        {
          fetch: serve(installer),
          now,
          llm: { ...options, maxPackages: 0 },
        },
      );
      expect(asked).toEqual([]);
      expect(outcome).toMatchObject({ status: "complete", verdict: "warn" });
      expect(outcome.status === "complete" && outcome.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: "llm/triage",
            message: expect.stringContaining("limit of 0 packages"),
          }),
        ]),
      );
      const tiny = await planInstallOnline(
        undefined,
        planWith(sri(installer)),
        {
          fetch: serve(installer),
          now,
          llm: { ...llm("malicious").options, maxDownloadBytes: 10 },
        },
      );
      expect(tiny).toMatchObject({ status: "complete", verdict: "warn" });
    });

    it("never lowers the verdict: a benign answer keeps the warning", async () => {
      const outcome = await planInstallOnline(
        undefined,
        planWith(sri(installer)),
        { fetch: serve(installer), now, llm: llm("benign").options },
      );
      expect(outcome).toMatchObject({ status: "complete", verdict: "warn" });
    });

    it("keeps the rules' verdict and says so when the model fails", async () => {
      const outcome = await planInstallOnline(
        undefined,
        planWith(sri(installer)),
        {
          fetch: serve(installer),
          now,
          llm: llm(new LlmError("overloaded")).options,
        },
      );
      expect(outcome).toMatchObject({ status: "complete", verdict: "warn" });
      expect(outcome.status === "complete" && outcome.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: "llm/triage",
            severity: "info",
            message: expect.stringContaining("overloaded"),
          }),
        ]),
      );
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

describe("planInstallOnline: provenance", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  const bundle = (file: string): unknown =>
    JSON.parse(
      readFileSync(
        new URL(`../crypto/fixtures/${file}`, import.meta.url),
        "utf8",
      ),
    );
  // semver's real provenance bundles (src/crypto/fixtures).
  const OLD = bundle("semver-7.5.2-provenance.json");
  const NEW = bundle("semver-7.7.2-provenance.json");
  const INTEGRITY = {
    "7.5.2":
      "sha512-SoftuTROv/cRjCze/scjGyiDtcUyxw1rgYQSZY7XTmtR5hX+dm76iDbTH8TkLPHCQmlbQVSSbNZCPM2hb0knnQ==",
    "7.7.2":
      "sha512-RF0Fw+rO5AMf9MAyaRXI4AV0Ulj5lMHqVxxdSgiVbixSCXoEmmX/jk0CuJw4+3SqroYO9VoUh+HcuJivvtJemA==",
  };
  const withProvenance = { attestations: { url: "x", provenance: {} } };
  const packument = JSON.stringify(
    signPackument({
      name: "semver",
      time: {
        created: "2011-01-01T00:00:00Z",
        "7.5.2": "2023-06-15T00:00:00Z",
        "7.7.2": "2025-05-12T00:00:00Z",
      },
      versions: {
        "7.5.2": { dist: { integrity: INTEGRITY["7.5.2"], ...withProvenance } },
        "7.7.2": { dist: { integrity: INTEGRITY["7.7.2"], ...withProvenance } },
      },
    }),
  );
  const plan = (
    attestations: Record<string, unknown>,
    seen: string[] = [],
    cache?: ContentCache,
  ) =>
    planInstallOnline(
      undefined,
      lock({
        "node_modules/semver": {
          version: "7.7.2",
          resolved: "https://registry.npmjs.org/semver/-/semver-7.7.2.tgz",
          integrity: INTEGRITY["7.7.2"],
        },
      }),
      {
        fetch: async (input) => {
          const url = String(input);
          seen.push(url);
          if (!url.includes("/attestations/"))
            return new Response(packument, { status: 200 });
          const body = attestations[url.slice(url.lastIndexOf("@") + 1)];
          return body === undefined
            ? new Response("", { status: 404 })
            : new Response(
                JSON.stringify({
                  attestations: [
                    {
                      predicateType: "https://slsa.dev/provenance/v1",
                      bundle: body,
                    },
                  ],
                }),
                { status: 200 },
              );
        },
        now,
        content: false,
        registryKeys: [TEST_REGISTRY_KEY],
        ...(cache === undefined ? {} : { cache }),
      },
    );
  const provenance = (outcome: Awaited<ReturnType<typeof plan>>) =>
    outcome.status === "complete"
      ? outcome.findings
          .filter((f) => f.ruleId === "install/provenance")
          .map((f) => f.severity)
      : outcome.reason;

  it("verifies the planned version and the one before it, and says nothing when the same build made both", async () => {
    const seen: string[] = [];
    const outcome = await plan({ "7.7.2": NEW, "7.5.2": OLD }, seen);
    expect(provenance(outcome)).toEqual([]);
    expect(seen.filter((u) => u.includes("/attestations/")).sort()).toEqual([
      "https://registry.npmjs.org/-/npm/v1/attestations/semver@7.5.2",
      "https://registry.npmjs.org/-/npm/v1/attestations/semver@7.7.2",
    ]);
  });

  const memoryCache = (): ContentCache => {
    const store = new Map<string, Finding[]>();
    return {
      get: (integrity, label) => store.get(`${integrity} ${label}`),
      set: (integrity, label, findings) =>
        void store.set(`${integrity} ${label}`, [...findings]),
    };
  };
  const attestationFetches = (seen: string[]) =>
    seen.filter((u) => u.includes("/attestations/")).length;

  it("remembers verified provenance, so a second plan fetches no attestation", async () => {
    const cache = memoryCache();
    const first: string[] = [];
    const second: string[] = [];
    const tampered = { "7.7.2": OLD, "7.5.2": OLD };
    const cold = await plan(tampered, first, cache);
    const warm = await plan(tampered, second, cache);
    expect([attestationFetches(first), attestationFetches(second)]).toEqual([
      2, 0,
    ]);
    expect(provenance(warm)).toEqual(provenance(cold));
    expect(provenance(warm)).toEqual(["block"]);
  });

  it("does not remember a bundle the registry did not serve", async () => {
    const cache = memoryCache();
    const second: string[] = [];
    await plan({ "7.5.2": OLD }, [], cache);
    expect(provenance(await plan({ "7.5.2": OLD }, second, cache))).toEqual([
      "warn",
    ]);
    expect(attestationFetches(second)).toBe(2);
  });

  it("warns when the registry lists provenance but serves none", async () => {
    expect(provenance(await plan({ "7.5.2": OLD }))).toEqual(["warn"]);
  });

  it("blocks an attestation that is not about this release", async () => {
    expect(provenance(await plan({ "7.7.2": OLD, "7.5.2": OLD }))).toEqual([
      "block",
    ]);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fetchPackument,
  fetchTarball,
  IntegrityError,
  packageUrl,
  RegistryError,
  registryTarball,
  tarballOf,
  verifyIntegrity,
  versionFacts,
} from "./registry.ts";

const now = new Date("2026-10-25T12:00:00Z");
const day = 24 * 60 * 60 * 1000;
const ago = (days: number): string =>
  new Date(now.getTime() - days * day).toISOString();

const packument = {
  name: "lib",
  time: {
    created: ago(400),
    "1.0.0": ago(300),
    "1.1.0": ago(100),
    "1.2.0": ago(2),
  },
  versions: {
    "1.0.0": { _npmUser: { name: "alice" }, dist: {} },
    "1.1.0": {
      _npmUser: { name: "alice" },
      dist: { attestations: { url: "x", provenance: { predicateType: "y" } } },
    },
    "1.2.0": {
      _npmUser: { name: "mallory" },
      dist: {},
      scripts: { postinstall: "node x.js", test: "t" },
      dependencies: { "plain-crypto-js": "^1" },
    },
  },
};

const fakeFetch =
  (
    responses: Record<string, { status: number; body?: string }>,
  ): typeof fetch =>
  async (input) => {
    const r = responses[String(input)];
    if (r === undefined) throw new Error(`unexpected ${String(input)}`);
    return new Response(r.body ?? "", { status: r.status });
  };

describe("packageUrl", () => {
  it("encodes scoped names and rejects anything that is not a valid npm name", () => {
    expect(packageUrl("lodash")).toBe("https://registry.npmjs.org/lodash");
    expect(packageUrl("@types/node")).toBe(
      "https://registry.npmjs.org/@types%2Fnode",
    );
    expect(packageUrl("JSONStream")).toBe(
      "https://registry.npmjs.org/JSONStream",
    );
    for (const bad of ["../evil", "a b", "x?y=1", "@s/../x", "", "a/b"]) {
      expect(() => packageUrl(bad)).toThrow(RegistryError);
    }
  });
});

describe("fetchPackument", () => {
  it("returns the document, or not-found on 404", async () => {
    const fetch = fakeFetch({
      "https://registry.npmjs.org/lib": {
        status: 200,
        body: JSON.stringify(packument),
      },
      "https://registry.npmjs.org/ghost": { status: 404 },
    });
    await expect(fetchPackument("lib", { fetch })).resolves.toMatchObject({
      name: "lib",
    });
    await expect(fetchPackument("ghost", { fetch })).resolves.toBe("not-found");
  });

  it("fails on server errors, invalid JSON, and responses over the size limit", async () => {
    const fetch = fakeFetch({
      "https://registry.npmjs.org/a": { status: 500 },
      "https://registry.npmjs.org/b": { status: 200, body: "{ nope" },
      "https://registry.npmjs.org/c": {
        status: 200,
        body: JSON.stringify({ big: "x".repeat(2000) }),
      },
    });
    await expect(fetchPackument("a", { fetch })).rejects.toThrow(/500/);
    await expect(fetchPackument("b", { fetch })).rejects.toThrow(RegistryError);
    await expect(
      fetchPackument("c", { fetch, maxBytes: 1000 }),
    ).rejects.toThrow(/too large/);
  });
});

describe("reading a response that breaks off", () => {
  const broken = (): typeof fetch => async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"name":'));
          controller.error(new TypeError("terminated"));
        },
      }),
    );

  it("turns a reset after the headers into a RegistryError", async () => {
    await expect(fetchPackument("lib", { fetch: broken() })).rejects.toThrow(
      RegistryError,
    );
    await expect(
      fetchTarball(
        "https://registry.npmjs.org/lib/-/lib-1.0.0.tgz",
        undefined,
        {
          fetch: broken(),
        },
      ),
    ).rejects.toThrow(/reading the response/);
  });
});

describe("versionFacts", () => {
  it("reads publish time, provenance, publisher, and history before the version", () => {
    expect(versionFacts(packument, "1.2.0", now)).toEqual({
      created: new Date(ago(400)),
      published: new Date(ago(2)),
      ageDays: 2,
      hasProvenance: false,
      publisher: "mallory",
      installScripts: ["postinstall"],
      installCommands: "postinstall: node x.js",
      dependencies: ["plain-crypto-js"],
      earlier: [
        {
          version: "1.1.0",
          hasProvenance: true,
          publisher: "alice",
          installScripts: [],
          installCommands: "",
          dependencies: [],
        },
        {
          version: "1.0.0",
          hasProvenance: false,
          publisher: "alice",
          installScripts: [],
          installCommands: "",
          dependencies: [],
        },
      ],
      previous: expect.objectContaining({ version: "1.1.0" }),
    });
  });

  it("leaves fresh versions out of the history, so a decoy cannot become the baseline", () => {
    const decoy = {
      ...packument,
      time: { ...packument.time, "1.2.0-rc.0": ago(3) },
      versions: {
        ...packument.versions,
        "1.2.0-rc.0": packument.versions["1.2.0"],
      },
    };
    const facts = versionFacts(decoy, "1.2.0", now);
    expect(facts?.earlier.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(facts?.previous?.version).toBe("1.1.0");
  });

  it("compares a backport with its own release line, not the newest release", () => {
    const lines = {
      name: "lib",
      time: {
        created: ago(900),
        "1.4.0": ago(400),
        "2.0.0": ago(200),
        "1.4.1": ago(100),
      },
      versions: { "1.4.0": {}, "2.0.0": {}, "1.4.1": {} },
    };
    expect(versionFacts(lines, "1.4.1", now)?.previous?.version).toBe("1.4.0");
    expect(versionFacts(lines, "2.0.0", now)?.previous?.version).toBe("1.4.0");
  });

  it("returns undefined for a version the registry does not know", () => {
    expect(versionFacts(packument, "9.9.9", now)).toBeUndefined();
  });
});

describe("registryTarball", () => {
  it.each([
    ["https://registry.npmjs.org/a/-/a-1.0.0.tgz", true],
    ["HTTPS://REGISTRY.NPMJS.ORG/a/-/a-1.0.0.tgz", true],
    ["https://registry.npmjs.org:443/a/-/a-1.0.0.tgz", true],
    ["https://registry.npmjs.org:8443/a/-/a-1.0.0.tgz", false],
    ["https://user:pw@registry.npmjs.org/a/-/a-1.0.0.tgz", false],
    ["http://registry.npmjs.org/a/-/a-1.0.0.tgz", false],
    ["https://registry.npmjs.org.evil.invalid/a.tgz", false],
    ["not a url", false],
  ])("%s → %s", (resolved, expected) => {
    expect(registryTarball(resolved) !== undefined).toBe(expected);
  });
});

describe("tarball download and integrity", () => {
  const data = Buffer.from("tarball bytes");
  const sri = `sha512-${createHash("sha512").update(data).digest("base64")}`;
  const url = "https://registry.npmjs.org/x/-/x-1.0.0.tgz";
  const serve =
    (body: Buffer): typeof fetch =>
    async () =>
      new Response(body, { status: 200 });

  it("verifies against the strongest listed hash", () => {
    expect(() => verifyIntegrity(data, `sha1-bogus ${sri}`)).not.toThrow();
    expect(() => verifyIntegrity(Buffer.from("tampered"), sri)).toThrow(
      IntegrityError,
    );
  });

  it("downloads, checks the hash, and refuses other hosts", async () => {
    await expect(
      fetchTarball(url, sri, { fetch: serve(data) }),
    ).resolves.toEqual(data);
    await expect(
      fetchTarball(url, sri, { fetch: serve(Buffer.from("evil")) }),
    ).rejects.toThrow(IntegrityError);
    await expect(
      fetchTarball("https://evil.invalid/x.tgz", sri, { fetch: serve(data) }),
    ).rejects.toThrow(RegistryError);
  });
});

describe("tarballOf", () => {
  it("reads a version's tarball URL and integrity", () => {
    const doc = {
      versions: {
        "1.0.0": {
          dist: {
            tarball: "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
            integrity: "sha512-x",
          },
        },
      },
    };
    expect(tarballOf(doc, "1.0.0")).toEqual({
      url: "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
      integrity: "sha512-x",
    });
    expect(tarballOf(doc, "2.0.0")).toBeUndefined();
    expect(tarballOf("not a packument", "1.0.0")).toBeUndefined();
  });
});

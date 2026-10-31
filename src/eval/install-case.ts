import { createHash } from "node:crypto";
import { REGISTRY } from "../install/registry.ts";
import { type PlanOutcome, planInstallOnline } from "../install/scan.ts";
import { signPackument, TEST_REGISTRY_KEY } from "../install/test-registry.ts";
import {
  isTestSigner,
  TEST_SIGSTORE,
  testProvenanceBundle,
} from "../install/test-sigstore.ts";
import { tar } from "../install/test-tar.ts";
import { snapshotRepo } from "../repo-snapshot.ts";

/**
 * Runs `croak plan` on an install fixture with a fake, in-memory registry:
 *
 *   package-lock.json          the planned install (after)
 *   before.package-lock.json   optional: the project's lockfile before
 *   registry/<name>.json       packuments, served at registry.npmjs.org/<name>,
 *                              each version signed by a test key unless it
 *                              states its own dist.signatures; a version's
 *                              "x-test-provenance" serves a provenance
 *                              bundle by a test signer (see provenanceFor)
 *   packages/<name>@<version>/ package files, served as that version's tarball
 *
 * Lockfile entries without `resolved` / `integrity` get the registry URL and
 * the hash of the built tarball, so fixtures stay hand-editable; an entry that
 * states its own integrity keeps it (a tampered-tarball case). No network.
 */

/** Fixture dates are relative to this clock. */
export const EVAL_NOW = new Date("2026-10-25T00:00:00Z");
/** One fixed platform, so os/cpu cases do not depend on the machine running the eval. */
const EVAL_PLATFORM = { os: "linux", cpu: "x64" } as const;

export class InstallFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallFixtureError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const tarballUrl = (name: string, version: string): string =>
  `${REGISTRY}/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;

/**
 * A fixture version's provenance: `"x-test-provenance": "acme"` signs an
 * attestation for that version as the test signer acme, and
 * `{ "signer": "acme", "about": "1.9.0" }` serves acme's attestation for
 * 1.9.0 instead (a replayed attestation). Read by this harness only.
 */
const TEST_PROVENANCE = "x-test-provenance";
const ATTESTATIONS = "-/npm/v1/attestations/";

function provenanceFor(
  name: string,
  version: string,
  meta: Record<string, unknown>,
  doc: Record<string, unknown>,
): unknown {
  const note = meta[TEST_PROVENANCE];
  const signer = isRecord(note) ? note.signer : note;
  const about =
    isRecord(note) && typeof note.about === "string" ? note.about : version;
  if (note === undefined) return undefined;
  if (!isTestSigner(signer))
    throw new InstallFixtureError(
      `registry/${name}.json ${version}: unknown test signer ${JSON.stringify(signer)}`,
    );
  const aboutMeta =
    isRecord(doc.versions) && isRecord(doc.versions[about])
      ? doc.versions[about]
      : {};
  const dist = isRecord(aboutMeta.dist) ? aboutMeta.dist : {};
  const integrity = typeof dist.integrity === "string" ? dist.integrity : "";
  return testProvenanceBundle({ name, version: about, integrity }, signer);
}

const sri = (data: Buffer): string =>
  `sha512-${createHash("sha512").update(data).digest("base64")}`;

export async function checkInstallFixture(
  fixtureDir: string,
): Promise<PlanOutcome> {
  const repo = snapshotRepo(fixtureDir);
  const read = (path: string): string | undefined => repo.read(path);

  // packages/<spec>/<file>, where spec is name@version and a scoped name spans two segments.
  const files = new Map<string, { name: string; content: string }[]>();
  for (const entry of repo.entries) {
    if (entry.kind !== "file" || !entry.path.startsWith("packages/")) continue;
    const parts = entry.path.split("/").slice(1);
    const width = parts[0]?.startsWith("@") === true ? 2 : 1;
    const spec = parts.slice(0, width).join("/");
    const list = files.get(spec) ?? [];
    list.push({
      name: `package/${parts.slice(width).join("/")}`,
      content: read(entry.path) ?? "",
    });
    files.set(spec, list);
  }
  const tarballs = new Map<string, Buffer>();
  for (const [spec, list] of files) {
    const at = spec.lastIndexOf("@");
    if (at <= 0)
      throw new InstallFixtureError(`packages/${spec}: not name@version`);
    tarballs.set(tarballUrl(spec.slice(0, at), spec.slice(at + 1)), tar(list));
  }

  const lockText = read("package-lock.json");
  if (lockText === undefined)
    throw new InstallFixtureError("missing package-lock.json");
  const lock: unknown = JSON.parse(lockText);
  if (!isRecord(lock) || !isRecord(lock.packages))
    throw new InstallFixtureError("package-lock.json has no packages map");
  for (const [path, raw] of Object.entries(lock.packages)) {
    if (path === "" || !isRecord(raw) || typeof raw.version !== "string")
      continue;
    if (raw.link === true) continue;
    const name =
      typeof raw.name === "string"
        ? raw.name
        : path.slice(
            path.lastIndexOf("node_modules/") + "node_modules/".length,
          );
    raw.resolved ??= tarballUrl(name, raw.version);
    const tgz = tarballs.get(String(raw.resolved));
    if (raw.integrity === undefined && tgz !== undefined)
      raw.integrity = sri(tgz);
  }

  // The registry's view of a package: signed like npm signs (each version's
  // tarball hash, or a stand-in hash for versions the fixture has no files
  // for), with dist.attestations where the fixture names a test signer.
  const packument = (name: string): Record<string, unknown> | undefined => {
    const text = read(`registry/${name}.json`);
    if (text === undefined) return undefined;
    const doc: unknown = JSON.parse(text);
    if (!isRecord(doc) || !isRecord(doc.versions)) return undefined;
    for (const meta of Object.values(doc.versions)) {
      if (!isRecord(meta) || meta[TEST_PROVENANCE] === undefined) continue;
      meta.dist = {
        ...(isRecord(meta.dist) ? meta.dist : {}),
        attestations: {
          url: "set-by-the-registry",
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      };
    }
    const signed = signPackument(doc, (version) => {
      const tgz = tarballs.get(tarballUrl(name, version));
      return sri(tgz ?? Buffer.from(`${name}@${version}`));
    });
    return isRecord(signed) ? signed : undefined;
  };
  const versionOf = (doc: Record<string, unknown>, version: string) =>
    isRecord(doc.versions) && isRecord(doc.versions[version])
      ? doc.versions[version]
      : {};

  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    const tgz = tarballs.get(url);
    if (tgz !== undefined) return new Response(new Uint8Array(tgz));
    const path = decodeURIComponent(url.slice(REGISTRY.length + 1));
    if (path.startsWith(ATTESTATIONS)) {
      const spec = path.slice(ATTESTATIONS.length);
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      const doc = packument(name);
      const bundle =
        doc === undefined
          ? undefined
          : provenanceFor(name, version, versionOf(doc, version), doc);
      return bundle === undefined
        ? new Response("not found", { status: 404 })
        : new Response(
            JSON.stringify({
              attestations: [
                { predicateType: "https://slsa.dev/provenance/v1", bundle },
              ],
            }),
          );
    }
    const doc = packument(path);
    if (doc === undefined) return new Response("not found", { status: 404 });
    // The fixture's signer note is the eval's, not the registry's.
    for (const meta of Object.values(
      isRecord(doc.versions) ? doc.versions : {},
    ))
      if (isRecord(meta)) delete meta[TEST_PROVENANCE];
    return new Response(JSON.stringify(doc));
  };

  return planInstallOnline(
    read("before.package-lock.json"),
    JSON.stringify(lock),
    {
      fetch: fakeFetch,
      now: EVAL_NOW,
      platform: EVAL_PLATFORM,
      registryKeys: [TEST_REGISTRY_KEY],
      sigstore: TEST_SIGSTORE,
    },
  );
}

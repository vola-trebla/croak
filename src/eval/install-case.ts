import { createHash } from "node:crypto";
import { type BuildPolicy, pnpmBuildPolicy } from "../install/pnpm-builds.ts";
import {
  type ProjectFs,
  pnpmfileFindings,
  projectScriptFindings,
  workspaceMembers,
} from "../install/project.ts";
import { REGISTRY } from "../install/registry.ts";
import { type PlanOutcome, planInstallOnline } from "../install/scan.ts";
import { signPackument, TEST_REGISTRY_KEY } from "../install/test-registry.ts";
import {
  isTestSigner,
  TEST_SIGSTORE,
  testProvenanceBundle,
} from "../install/test-sigstore.ts";
import { tar } from "../install/test-tar.ts";
import { type RepoSnapshot, snapshotRepo } from "../repo-snapshot.ts";
import { aggregate, type Finding } from "../verdict.ts";

/**
 * Runs `croak plan` on an install fixture with a fake, in-memory registry:
 *
 *   package-lock.json          the planned install (after), or pnpm-lock.yaml
 *   before.package-lock.json   optional: the project's lockfile before (for
 *                              pnpm: before.pnpm-lock.yaml)
 *   package.json               optional: the project itself, so the plan is
 *                              a plain install of it, as `croak plan
 *                              --project` checks one: its own install scripts
 *                              and its workspace members' (D35, D47)
 *   pnpm-workspace.yaml,       pnpm only: the project's build rule (which
 *   .pnpmfile.cjs              install scripts pnpm 10+ runs, with
 *                              package.json) and the code pnpm loads on every
 *                              install, as `croak plan --pnpm-builds` reads them
 *   registry/<name>.json       packuments, served at registry.npmjs.org/<name>,
 *                              each version signed by a test key unless it
 *                              states its own dist.signatures; a version's
 *                              "x-test-provenance" serves a provenance
 *                              bundle by a test signer (see provenanceFor)
 *   packages/<name>@<version>/ package files, served as that version's tarball
 *
 * Lockfile entries without `resolved` / `integrity` get the registry URL and
 * the hash of the built tarball, so fixtures stay hand-editable; an entry that
 * states its own integrity keeps it (a tampered-tarball case). In
 * pnpm-lock.yaml, a package's `resolution: {}` gets the hash. No network.
 */

/** Fixture dates are relative to this clock. */
export const EVAL_NOW = new Date("2026-10-25T00:00:00Z");
/** One fixed platform, so os/cpu cases do not depend on the machine running the eval. */
const EVAL_PLATFORM = { os: "linux", cpu: "x64" } as const;
/** The pnpm a pnpm case is planned with (its build rule needs 10 or later). */
const EVAL_PNPM_VERSION = "10.28.2";

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

/** The fixture as the project folder `croak plan --project` reads. */
const projectFs = (repo: RepoSnapshot): ProjectFs => {
  const kinds = new Map(repo.entries.map((e) => [e.path, e]));
  return {
    read: (path) => repo.read(path),
    kind: (path) => {
      const entry = kinds.get(path);
      if (entry === undefined) return undefined;
      return {
        kind: entry.kind === "symlink" ? "symlink" : "file",
        size: entry.size,
      };
    },
  };
};

const sri = (data: Buffer): string =>
  `sha512-${createHash("sha512").update(data).digest("base64")}`;

/** package-lock.json with each entry's missing `resolved` and `integrity` filled in. */
function fillNpmLock(text: string, tarballs: Map<string, Buffer>): string {
  const lock: unknown = JSON.parse(text);
  if (!isRecord(lock) || !isRecord(lock.packages))
    throw new InstallFixtureError("package-lock.json has no packages map");
  for (const [path, raw] of Object.entries(lock.packages)) {
    if (path === "" || !isRecord(raw) || typeof raw.version !== "string")
      continue;
    // Links and workspace members (keys outside node_modules) are local folders.
    if (raw.link === true || !path.includes("node_modules/")) continue;
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
  return JSON.stringify(lock);
}

/**
 * pnpm-lock.yaml with each `resolution: {}` under `packages:` given the built
 * tarball's integrity. Textual, line by line: the fixture is written by hand
 * in the shape pnpm writes (two-space package keys, four-space fields), and
 * croak's own parser then reads the result like any other lockfile.
 */
function fillPnpmLock(text: string, tarballs: Map<string, Buffer>): string {
  let inPackages = false;
  let key: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      if (/^\S/.test(line)) {
        inPackages = /^packages:\s*$/.test(line);
        key = undefined;
        return line;
      }
      if (!inPackages) return line;
      const head = /^ {2}(\S.*):\s*$/.exec(line)?.[1];
      if (head !== undefined) {
        key = head.replace(/^(['"])(.*)\1$/, "$2");
        return line;
      }
      if (key === undefined || !/^ {4}resolution: \{\}\s*$/.test(line))
        return line;
      const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
      const tgz =
        at <= 0
          ? undefined
          : tarballs.get(tarballUrl(key.slice(0, at), key.slice(at + 1)));
      return tgz === undefined
        ? line
        : `    resolution: {integrity: ${sri(tgz)}}`;
    })
    .join("\n");
}

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

  // One package manager per case: npm's lockfile, or pnpm's with its build rule.
  const npmLock = read("package-lock.json");
  const pnpmLock = read("pnpm-lock.yaml");
  if (npmLock !== undefined && pnpmLock !== undefined)
    throw new InstallFixtureError(
      "has both package-lock.json and pnpm-lock.yaml: pick one package manager",
    );
  let after: string;
  let before: string | undefined;
  let builds: { manager: "npm" | "pnpm"; mayRun: BuildPolicy } | undefined;
  if (pnpmLock !== undefined) {
    if (read("before.package-lock.json") !== undefined)
      throw new InstallFixtureError(
        "a pnpm case's earlier lockfile is before.pnpm-lock.yaml",
      );
    after = fillPnpmLock(pnpmLock, tarballs);
    before = read("before.pnpm-lock.yaml");
    const mayRun = pnpmBuildPolicy(
      {
        packageJson: read("package.json"),
        workspaceYaml: read("pnpm-workspace.yaml"),
      },
      EVAL_PNPM_VERSION,
    );
    builds = mayRun === undefined ? undefined : { manager: "pnpm", mayRun };
  } else if (npmLock !== undefined) {
    after = fillNpmLock(npmLock, tarballs);
    before = read("before.package-lock.json");
  } else
    throw new InstallFixtureError(
      "missing package-lock.json (or pnpm-lock.yaml)",
    );

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

  const outcome = await planInstallOnline(before, after, {
    fetch: fakeFetch,
    now: EVAL_NOW,
    platform: EVAL_PLATFORM,
    registryKeys: [TEST_REGISTRY_KEY],
    sigstore: TEST_SIGSTORE,
    ...(builds === undefined ? {} : { builds }),
  });
  if (outcome.status !== "complete") return outcome;
  // What the planning wrapper adds for the project (scripts/croak-install.sh):
  // the pnpmfile on every pnpm install (D39), the project's own install
  // scripts on a plain install (D35). The fixture's package.json is that
  // project; without one, the case is about the packages alone.
  const fs = projectFs(repo);
  const pnpm = pnpmLock !== undefined;
  const extra: Finding[] = [
    ...(pnpm ? pnpmfileFindings(".", fs) : []),
    ...(read("package.json") === undefined
      ? []
      : projectScriptFindings(".", fs, {
          members: workspaceMembers(after),
          pnpm,
        })),
  ];
  if (extra.length === 0) return outcome;
  const findings = [...extra, ...outcome.findings];
  return { ...outcome, findings, verdict: aggregate(findings) };
}

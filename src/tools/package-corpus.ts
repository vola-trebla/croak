/**
 * False-alarm check on real npm packages (eval/packages.json). Each pinned
 * version is checked on its own with `croak plan`: a one-entry lockfile built
 * from the registry (tarball URL, integrity, install scripts, os/cpu), at the
 * clock the list was pinned on, so release ages and verdicts stay the same.
 * Needs the network; not run in CI. Every block and warning is printed: on
 * popular packages a block is almost certainly a false alarm. Exits 1 when a
 * package cannot be checked or blocks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fetchPackument } from "../install/registry.ts";
import { type PlanOutcome, planInstallOnline } from "../install/scan.ts";
import type { Severity } from "../verdict.ts";

interface CorpusPackage {
  readonly name: string;
  readonly version: string;
  readonly why: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadPackages(root: string): {
  now: Date;
  packages: CorpusPackage[];
} {
  const data: unknown = JSON.parse(
    readFileSync(join(root, "eval/packages.json"), "utf8"),
  );
  const now = isRecord(data)
    ? new Date(String(data.now))
    : new Date(Number.NaN);
  const packages = isRecord(data) ? data.packages : undefined;
  if (
    Number.isNaN(now.getTime()) ||
    !Array.isArray(packages) ||
    !packages.every(
      (p) =>
        isRecord(p) &&
        typeof p.name === "string" &&
        typeof p.version === "string" &&
        typeof p.why === "string",
    )
  )
    throw new Error("eval/packages.json: needs a valid now and packages list");
  return { now, packages: packages as CorpusPackage[] };
}

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

/** The lockfile npm would write for installing just this version. */
export function lockfileFor(
  packument: unknown,
  name: string,
  version: string,
): string {
  const versions =
    isRecord(packument) && isRecord(packument.versions)
      ? packument.versions
      : {};
  const meta = versions[version];
  if (!isRecord(meta))
    throw new Error(`${name}@${version}: not on the registry`);
  const dist = isRecord(meta.dist) ? meta.dist : {};
  const scripts = isRecord(meta.scripts) ? meta.scripts : {};
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((v) => typeof v === "string")
      ? value
      : undefined;
  const entry = {
    version,
    resolved: dist.tarball,
    integrity: dist.integrity,
    ...(INSTALL_SCRIPTS.some((s) => typeof scripts[s] === "string") ||
    meta.gypfile === true
      ? { hasInstallScript: true }
      : {}),
    ...(strings(meta.os) === undefined ? {} : { os: meta.os }),
    ...(strings(meta.cpu) === undefined ? {} : { cpu: meta.cpu }),
  };
  return JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, [`node_modules/${name}`]: entry },
  });
}

/** fetch with packuments remembered, so each one is downloaded once per package. */
function cachingFetch(): typeof fetch {
  const cache = new Map<string, string>();
  return async (input, init) => {
    const url = String(input);
    const hit = cache.get(url);
    if (hit !== undefined) return new Response(hit);
    const response = await fetch(input, init);
    if (url.endsWith(".tgz") || !response.ok) return response;
    const text = await response.text();
    cache.set(url, text);
    return new Response(text, { status: response.status });
  };
}

const count = (outcome: PlanOutcome, severity: Severity): number =>
  outcome.status === "complete"
    ? outcome.findings.filter((f) => f.severity === severity).length
    : 0;

async function main(root: string): Promise<number> {
  const { values } = parseArgs({
    options: { json: { type: "boolean" } },
    strict: true,
  });
  const { now, packages } = loadPackages(root);
  const results: {
    pkg: CorpusPackage;
    outcome?: PlanOutcome;
    error?: string;
  }[] = [];
  for (const pkg of packages) {
    const doFetch = cachingFetch();
    try {
      const doc = await fetchPackument(pkg.name, { fetch: doFetch });
      const lock = lockfileFor(doc, pkg.name, pkg.version);
      results.push({
        pkg,
        outcome: await planInstallOnline(undefined, lock, {
          fetch: doFetch,
          now,
        }),
      });
    } catch (error) {
      results.push({
        pkg,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    const label = (p: CorpusPackage) => `${p.name}@${p.version}`;
    const width = Math.max(...results.map((r) => label(r.pkg).length));
    const lines = [
      `croak package corpus — false-alarm check on ${results.length} npm packages (clock ${now.toISOString().slice(0, 10)})`,
      "",
    ];
    for (const { pkg, outcome, error } of results) {
      const verdict =
        outcome === undefined
          ? `ERROR ${error}`
          : outcome.status === "complete"
            ? `${outcome.verdict.toUpperCase().padEnd(10)}  block ${count(outcome, "block")}  warn ${count(outcome, "warn")}  info ${count(outcome, "info")}  ${Math.round(outcome.durationMs)} ms`
            : `INCOMPLETE  ${outcome.reason}`;
      lines.push(`  ${label(pkg).padEnd(width)}  ${verdict}`);
    }
    const flagged = results.filter(
      (r) => r.outcome?.status === "complete" && r.outcome.verdict !== "allow",
    );
    lines.push(
      "",
      `allow ${results.filter((r) => r.outcome?.status === "complete" && r.outcome.verdict === "allow").length}  warn ${flagged.filter((r) => r.outcome?.status === "complete" && r.outcome.verdict === "warn").length}  block ${flagged.filter((r) => r.outcome?.status === "complete" && r.outcome.verdict === "block").length}  not checked ${results.filter((r) => r.outcome?.status !== "complete").length}`,
      "",
      "Blocks and warnings to review:",
    );
    for (const { outcome } of flagged) {
      if (outcome?.status !== "complete") continue;
      for (const f of outcome.findings.filter((x) => x.severity !== "info"))
        lines.push(
          `  [${f.severity}] ${f.file}${f.line === undefined ? "" : `:${f.line}`}  ${f.ruleId}`,
          `      ${f.message}`,
        );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return results.some(
    (r) => r.outcome?.status !== "complete" || r.outcome.verdict === "block",
  )
    ? 1
    : 0;
}

if (import.meta.main)
  process.exitCode = await main(join(import.meta.dirname, "../.."));

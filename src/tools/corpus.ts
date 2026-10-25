/**
 * False-alarm check on real repositories (eval/corpus.json). Fetch them first
 * with `pnpm corpus:fetch`; this tool only reads. Every block and warning is
 * printed so a human can judge it: on popular, legitimate projects a block is
 * almost certainly a false alarm, and a warning should be explainable.
 * Informational: exits 0 unless a repo cannot be scanned at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type ScanOutcome, scanRepoAt } from "../scan.ts";
import type { Severity } from "../verdict.ts";

interface CorpusRepo {
  readonly name: string;
  readonly repo: string;
  readonly commit: string;
}

function isCorpusRepo(value: unknown): value is CorpusRepo {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "repo" in value &&
    typeof value.repo === "string" &&
    "commit" in value &&
    typeof value.commit === "string"
  );
}

function loadCorpus(root: string): CorpusRepo[] {
  const data: unknown = JSON.parse(
    readFileSync(join(root, "eval/corpus.json"), "utf8"),
  );
  const repos =
    typeof data === "object" && data !== null && "repos" in data
      ? data.repos
      : undefined;
  if (!Array.isArray(repos) || !repos.every(isCorpusRepo))
    throw new Error("eval/corpus.json: invalid repos list");
  return repos;
}

const count = (outcome: ScanOutcome, severity: Severity): number =>
  outcome.status === "complete"
    ? outcome.findings.filter((f) => f.severity === severity).length
    : 0;

function main(root: string): number {
  const { values } = parseArgs({
    options: { json: { type: "boolean" } },
    strict: true,
  });
  const results = loadCorpus(root).map((repo) => {
    const dir = join(root, "eval/corpus/repos", repo.name);
    try {
      return { repo, outcome: scanRepoAt(dir) };
    } catch (error) {
      return {
        repo,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }

  const width = Math.max(...results.map((r) => r.repo.name.length));
  const lines = ["croak corpus — false-alarm check on real repositories", ""];
  for (const r of results) {
    if (!("outcome" in r)) {
      lines.push(
        `  ${r.repo.name.padEnd(width)}  not scanned: ${r.error} (run pnpm corpus:fetch)`,
      );
      continue;
    }
    const { outcome } = r;
    const verdict =
      outcome.status === "complete"
        ? outcome.verdict.toUpperCase()
        : "INCOMPLETE";
    const files =
      outcome.status === "complete"
        ? `${outcome.filesScanned} files`
        : outcome.reason;
    lines.push(
      `  ${r.repo.name.padEnd(width)}  ${verdict.padEnd(10)}  block ${count(outcome, "block")}  warn ${count(outcome, "warn")}  info ${count(outcome, "info")}  ${files}  ${Math.round(outcome.durationMs)} ms`,
    );
  }
  lines.push("", "Blocks and warnings to review:");
  for (const r of results) {
    if (!("outcome" in r) || r.outcome.status !== "complete") continue;
    for (const f of r.outcome.findings.filter((x) => x.severity !== "info")) {
      lines.push(
        `  [${f.severity}] ${r.repo.name}/${f.file}${f.line === undefined ? "" : `:${f.line}`}  ${f.ruleId}`,
        `      ${f.message}`,
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return results.some((r) => !("outcome" in r)) ? 1 : 0;
}

if (import.meta.main)
  process.exitCode = main(join(import.meta.dirname, "../.."));

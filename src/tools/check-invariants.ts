/**
 * Mechanical tripwire for croak's invariants (CLAUDE.md, D4, D9). Runs on every
 * PR. It is regex over source text, not a parser: it may flag a match inside a
 * comment, and that is acceptable — rephrase the comment.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

const SOURCE_RULES: ReadonlyArray<{
  readonly rule: string;
  readonly pattern: RegExp;
}> = [
  { rule: "no-process-spawn", pattern: /["'](?:node:)?child_process["']/ },
  { rule: "no-vm", pattern: /["'](?:node:)?vm["']/ },
  { rule: "no-workers", pattern: /["'](?:node:)?worker_threads["']/ },
  { rule: "no-module-loader", pattern: /["'](?:node:)?module["']/ },
  { rule: "no-eval", pattern: /\beval\s*\(|\bnew\s+Function\s*\(/ },
  { rule: "no-require", pattern: /\brequire\s*\(/ },
  { rule: "no-dynamic-import", pattern: /\bimport\s*\(/ },
  {
    rule: "no-fs-write",
    pattern:
      /\b(?:writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|symlink|link|chmod|chown|truncate|utimes)(?:Sync)?\s*\(|\bcreateWriteStream\s*\(/,
  },
];

/** Checks one source file of croak's own (non-test) code. */
export function checkSource(file: string, text: string): Violation[] {
  return text.split("\n").flatMap((lineText, index) =>
    SOURCE_RULES.filter(({ pattern }) => pattern.test(lineText)).map(
      ({ rule }) => ({
        file,
        line: index + 1,
        rule,
        text: lineText.trim(),
      }),
    ),
  );
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
];
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hasEntries = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : isRecord(value) && Object.keys(value).length > 0;

/** croak ships no runtime dependencies (D4) and no install-time scripts of its own. */
export function checkPackageJson(manifest: unknown): Violation[] {
  if (!isRecord(manifest))
    return [
      { file: "package.json", line: 1, rule: "invalid-manifest", text: "" },
    ];
  const violations: Violation[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    if (hasEntries(manifest[field])) {
      violations.push({
        file: "package.json",
        line: 1,
        rule: "no-runtime-deps",
        text: field,
      });
    }
  }
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  for (const script of INSTALL_SCRIPTS) {
    if (script in scripts) {
      violations.push({
        file: "package.json",
        line: 1,
        rule: "no-install-scripts",
        text: script,
      });
    }
  }
  return violations;
}

function main(root: string): number {
  const self = relative(root, import.meta.filename);
  const sources = readdirSync(join(root, "src"), {
    recursive: true,
    encoding: "utf8",
  })
    .map((path) => join("src", path))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    // This file spells out the forbidden patterns, so it is the one exemption.
    .filter((path) => path !== self);

  const violations = [
    ...sources.flatMap((path) =>
      checkSource(path, readFileSync(join(root, path), "utf8")),
    ),
    ...checkPackageJson(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    ),
  ];

  for (const v of violations)
    process.stderr.write(`${v.file}:${v.line}  ${v.rule}  ${v.text}\n`);
  process.stdout.write(
    violations.length === 0
      ? `invariants: ${sources.length} source files + package.json clean\n`
      : `invariants: ${violations.length} violation(s)\n`,
  );
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.main)
  process.exitCode = main(join(import.meta.dirname, "../.."));

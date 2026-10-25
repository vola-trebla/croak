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

type Scope = "all" | "source";

/**
 * "all" rules also apply to test files: a test must not execute fixture code
 * either. "source" rules apply to non-test code only (tests may write fixtures
 * and assert on the eval marker).
 */
const SOURCE_RULES: ReadonlyArray<{
  readonly rule: string;
  readonly scope: Scope;
  readonly pattern: RegExp;
}> = [
  {
    rule: "no-process-spawn",
    scope: "all",
    pattern: /["'](?:node:)?child_process["']/,
  },
  { rule: "no-vm", scope: "all", pattern: /["'](?:node:)?vm["']/ },
  {
    rule: "no-workers",
    scope: "all",
    pattern: /["'](?:node:)?worker_threads["']/,
  },
  {
    rule: "no-module-loader",
    scope: "all",
    pattern: /\b(?:from|import)\s*\(?\s*["'](?:node:)?module["']/,
  },
  {
    rule: "no-inspector",
    scope: "all",
    pattern: /["'](?:node:)?(?:inspector|repl)(?:\/promises)?["']/,
  },
  {
    rule: "no-eval",
    scope: "all",
    pattern:
      /\beval\s*\)?\s*\(|\bFunction\s*\(|\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\b/,
  },
  { rule: "no-require", scope: "all", pattern: /\brequire\s*\(/ },
  { rule: "no-dynamic-import", scope: "all", pattern: /\bimport\s*\(/ },
  {
    rule: "no-fs-write",
    scope: "source",
    pattern: new RegExp(
      [
        /\b(?:writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|symlink|link|chmod|chown|lchown|utimes|lutimes)(?:Sync)?\s*\(/
          .source,
        /\b(?:writeSync|writev(?:Sync)?|truncateSync|ftruncate(?:Sync)?|createWriteStream)\s*\(/
          .source,
        /\bfs\.truncate\s*\(/.source,
        /\bopen(?:Sync)?\s*\([^)]*,\s*["'][wa+]/.source,
        /\bO_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b/.source,
      ].join("|"),
    ),
  },
  {
    rule: "no-eval-marker",
    scope: "source",
    pattern: /croak-eval-synthetic|synthetic croak eval/i,
  },
];

/** Checks one file of croak's own code; test files get the "all" rules only. */
export function checkSource(
  file: string,
  text: string,
  isTest: boolean,
): Violation[] {
  const rules = SOURCE_RULES.filter(({ scope }) => scope === "all" || !isTest);
  return text.split("\n").flatMap((lineText, index) =>
    rules
      .filter(({ pattern }) => pattern.test(lineText))
      .map(({ rule }) => ({
        file,
        line: index + 1,
        rule,
        text: lineText.trim(),
      })),
  );
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
];
// Every script npm runs during `npm install` of the package itself.
const INSTALL_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
];

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
  // This file and its test spell out the forbidden patterns: the only exemptions.
  const self = relative(root, import.meta.filename);
  const exempt = new Set([self, self.replace(/\.ts$/, ".test.ts")]);
  const files = readdirSync(join(root, "src"), {
    recursive: true,
    encoding: "utf8",
  })
    .map((path) => join("src", path))
    .filter((path) => path.endsWith(".ts") && !exempt.has(path));

  const violations = [
    ...files.flatMap((path) =>
      checkSource(
        path,
        readFileSync(join(root, path), "utf8"),
        path.endsWith(".test.ts"),
      ),
    ),
    ...checkPackageJson(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    ),
  ];

  for (const v of violations)
    process.stderr.write(`${v.file}:${v.line}  ${v.rule}  ${v.text}\n`);
  process.stdout.write(
    violations.length === 0
      ? `invariants: ${files.length} files + package.json clean\n`
      : `invariants: ${violations.length} violation(s)\n`,
  );
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.main)
  process.exitCode = main(join(import.meta.dirname, "../.."));

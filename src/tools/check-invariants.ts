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
 * "all" rules also apply to test files: loading APIs (import(), require,
 * child_process, vm, workers, module, inspector) are how a test would run
 * fixture code. "source" rules apply to non-test code only: tests write
 * fixtures, assert on the eval marker, and hold malicious-looking strings
 * such as `eval(atob(…))` as test data for detectors.
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
    scope: "source",
    pattern:
      /\beval\s*\)?\s*\(|\bFunction\s*\(|\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\b/,
  },
  { rule: "no-require", scope: "all", pattern: /\brequire\s*\(/ },
  // process.getBuiltinModule("child_process") loads any built-in by name.
  {
    rule: "no-builtin-loader",
    scope: "all",
    pattern: /\bgetBuiltinModule\s*\(/,
  },
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

/** Marks a file whose strings are detector patterns or test data (see D16). */
export const PATTERN_DATA_MARKER = "// croak-invariants: pattern-data";
// Prefixes: two directories, plus the ReDoS guard, whose fragments are data too.
const PATTERN_DATA_DIRS = [
  "src/signals/",
  "src/detectors/",
  "src/install/",
  "src/tools/redos-check.",
];

const FORBIDDEN_MODULES =
  "child_process|vm|worker_threads|module|inspector|repl";
const ASSIGNED = String.raw`^\s*(?:export\s+)?(?:(?:const|let|var)\s+[^=]+=\s*)?(?:await\s+)?`;

/**
 * Pattern-data files legitimately hold strings such as require("child_process")
 * as data, so they get statement-level rules: an import, require, dynamic
 * import, or eval that starts a statement is still a violation.
 */
const STATEMENT_RULES: ReadonlyArray<{
  readonly rule: string;
  readonly pattern: RegExp;
}> = [
  {
    rule: "no-forbidden-import",
    pattern: new RegExp(
      String.raw`^\s*(?:import|export)\b[^"'\x60]*["'](?:node:)?(?:${FORBIDDEN_MODULES})["']`,
    ),
  },
  { rule: "no-require", pattern: new RegExp(`${ASSIGNED}require\\s*\\(`) },
  {
    rule: "no-dynamic-import",
    pattern: new RegExp(`${ASSIGNED}import\\s*\\(`),
  },
  {
    rule: "no-eval",
    pattern: new RegExp(
      String.raw`${ASSIGNED}(?:\(0,\s*)?(?:eval\s*\)?|new\s+Function)\s*\(`,
    ),
  },
  {
    // The closing line of a multi-line import: } from "node:child_process";
    rule: "no-forbidden-import",
    pattern: new RegExp(
      String.raw`^\s*\}?\s*from\s*["'](?:node:)?(?:${FORBIDDEN_MODULES})["']`,
    ),
  },
  {
    rule: "no-builtin-loader",
    pattern: new RegExp(`${ASSIGNED}[\\w.]*getBuiltinModule\\s*\\(`),
  },
  {
    rule: "no-eval",
    pattern: new RegExp(
      `${ASSIGNED}process\\s*\\.\\s*(?:binding|_linkedBinding|dlopen)\\b`,
    ),
  },
];

const violationsFor = (
  file: string,
  text: string,
  rules: ReadonlyArray<{ readonly rule: string; readonly pattern: RegExp }>,
): Violation[] =>
  text.split("\n").flatMap((lineText, index) =>
    rules
      .filter(({ pattern }) => pattern.test(lineText))
      .map(({ rule }) => ({
        file,
        line: index + 1,
        rule,
        text: lineText.trim(),
      })),
  );

/**
 * Checks one file of croak's own code. Test files get the "all" rules only;
 * pattern-data files (marker in the first lines, allowed directories only)
 * get statement-level rules, plus "source" rules when they are not tests.
 */
/**
 * The one file allowed to write (D33): the content verdict cache, into
 * croak's own cache directory only. Every other rule still applies to it.
 */
export const WRITE_ALLOWED: ReadonlySet<string> = new Set([
  "src/install/content-cache.ts",
]);

/**
 * The one dynamic import allowed (D36): the Anthropic SDK, by its literal
 * name, loaded only when the opt-in LLM step runs. Never a computed specifier.
 */
export const SDK_IMPORT_FILE = "src/llm/client.ts";
const SDK_IMPORT =
  /^\s*const \{ default: Anthropic \} = await import\("@anthropic-ai\/sdk"\);\s*$/;

export function checkSource(
  file: string,
  text: string,
  isTest: boolean,
): Violation[] {
  return checkSourceRules(file, text, isTest).filter(
    (v) =>
      !(v.rule === "no-fs-write" && WRITE_ALLOWED.has(file)) &&
      !(
        v.rule === "no-dynamic-import" &&
        file === SDK_IMPORT_FILE &&
        SDK_IMPORT.test(v.text)
      ),
  );
}

function checkSourceRules(
  file: string,
  text: string,
  isTest: boolean,
): Violation[] {
  const marked = text
    .split("\n", 5)
    .some((line) => line.trim() === PATTERN_DATA_MARKER);
  if (!marked) {
    return violationsFor(
      file,
      text,
      SOURCE_RULES.filter(({ scope }) => scope === "all" || !isTest),
    );
  }
  if (!PATTERN_DATA_DIRS.some((dir) => file.startsWith(dir))) {
    return [
      {
        file,
        line: 1,
        rule: "pattern-data-outside-allowed-dirs",
        text: PATTERN_DATA_MARKER,
      },
    ];
  }
  const sourceOnly = isTest
    ? []
    : SOURCE_RULES.filter(({ rule }) => rule === "no-fs-write");
  return violationsFor(file, text, [...STATEMENT_RULES, ...sourceOnly]);
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
  // runs after node_modules changes (npm docs)
  "dependencies",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hasEntries = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : isRecord(value) && Object.keys(value).length > 0;

/**
 * The one runtime dependency croak may ship (D36): Anthropic's official SDK,
 * for the opt-in LLM layer only, pinned to an exact version so an install
 * never picks up a release croak has not checked.
 */
export const ALLOWED_DEPENDENCIES: ReadonlySet<string> = new Set([
  "@anthropic-ai/sdk",
]);
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** croak ships no other runtime dependencies (D4, D36) and no install-time scripts of its own. */
export function checkPackageJson(manifest: unknown): Violation[] {
  if (!isRecord(manifest))
    return [
      { file: "package.json", line: 1, rule: "invalid-manifest", text: "" },
    ];
  const violations: Violation[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!hasEntries(deps)) continue;
    const entries = isRecord(deps) ? Object.entries(deps) : [[field, ""]];
    for (const [name, version] of entries) {
      if (
        field === "dependencies" &&
        ALLOWED_DEPENDENCIES.has(name) &&
        typeof version === "string" &&
        EXACT_VERSION.test(version)
      )
        continue;
      violations.push({
        file: "package.json",
        line: 1,
        rule: "no-runtime-deps",
        text: `${field}: ${name}`,
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

const USES = /^\s*(?:-\s+)?uses:\s*(\S+)/;
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

/**
 * Every action a workflow runs is pinned by commit SHA (M0): a tag can be
 * moved to other code, and the release workflow holds the right to publish
 * croak (D49). Local actions (`./…`) are part of the repository.
 */
export function checkWorkflow(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  text.split("\n").forEach((line, index) => {
    const ref = USES.exec(line)?.[1];
    if (ref === undefined || ref.startsWith("./") || PINNED.test(ref)) return;
    violations.push({
      file,
      line: index + 1,
      rule: "pinned-actions",
      text: line.trim(),
    });
  });
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

  const workflows = readdirSync(join(root, ".github/workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(".github/workflows", name));
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
    ...workflows.flatMap((path) =>
      checkWorkflow(path, readFileSync(join(root, path), "utf8")),
    ),
  ];

  for (const v of violations)
    process.stderr.write(`${v.file}:${v.line}  ${v.rule}  ${v.text}\n`);
  process.stdout.write(
    violations.length === 0
      ? `invariants: ${files.length} files + package.json + ${workflows.length} workflow(s) clean\n`
      : `invariants: ${violations.length} violation(s)\n`,
  );
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.main)
  process.exitCode = main(join(import.meta.dirname, "../.."));

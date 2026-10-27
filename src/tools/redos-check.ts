// croak-invariants: pattern-data
// The fragments below are pathological test inputs, not code (D16).
/**
 * ReDoS guard (security model §4). Runs every detector regex — and the shell
 * analyzer — against pathological inputs and fails if any single run exceeds
 * its time budget. Catastrophic backtracking blocks the event loop, so this
 * cannot be a Vitest test: it runs as its own process (`pnpm redos`), and CI
 * gives that step a hard timeout so a hung regex kills only this step.
 */
import { performance } from "node:perf_hooks";
import { parseYamlDocuments, YamlError } from "../install/yaml.ts";
import { CODE_PATTERNS } from "../signals/code.ts";
import { hiddenCode } from "../signals/hidden.ts";
import { parseJsonc } from "../signals/jsonc.ts";
import { OBFUSCATION_PATTERNS } from "../signals/obfuscation.ts";
import { analyzeShell, MAX_SCRIPT_LENGTH } from "../signals/shell.ts";

const LENGTH = 100_000;
const REGEX_BUDGET_MS = 100;

/** Repeated fragments that drive backtracking in common pattern shapes. */
const FRAGMENTS = [
  " ",
  "\t",
  "a",
  ".",
  "(",
  '"',
  "'",
  "/",
  "\\x41",
  "~.",
  "_0x",
  "eval",
  "eval )",
  "fetch ",
  "require(",
  'require("',
  "import(",
  "from ",
  "process.env",
  "process . env ",
  "Buffer.from(",
  "Buffer . from (a,",
  "String.fromCharCode",
  "atob",
  "new Function",
  "Function(",
  "id_",
  "Login ",
  "\\x",
  "_0x1",
  "globalThis[",
  "window[a",
  "QUJD",
  "['push'](",
];

export function pathological(length: number): string[] {
  return FRAGMENTS.flatMap((fragment) => {
    const run = fragment
      .repeat(Math.ceil(length / fragment.length))
      .slice(0, length);
    // A near-miss suffix forces a failing match after a long run.
    return [run, `${run}!`, `${run}\n`];
  });
}

export interface Run {
  readonly what: string;
  readonly input: string;
  readonly ms: number;
}

function time(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

const preview = (input: string): string =>
  `${JSON.stringify(input.slice(0, 16))}…`;

/** Every (pattern, input) run, slowest first. */
export function timePatterns(
  patterns: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }>,
  inputs: readonly string[],
): Run[] {
  return patterns
    .flatMap(({ label, pattern }) =>
      inputs.map((input) => ({
        what: `code/${label}`,
        input: preview(input),
        ms: time(() => pattern.test(input)),
      })),
    )
    .sort((a, b) => b.ms - a.ms);
}

/** Times a scanner on every input, slowest first. Rejecting hostile input is fine. */
function timeScanner(
  what: string,
  scan: (input: string) => unknown,
  inputs: readonly string[],
): Run[] {
  const attempt = (input: string): void => {
    try {
      scan(input);
    } catch {
      // Only the time matters here; parse errors on hostile input are expected.
    }
  };
  return inputs
    .map((input) => ({
      what,
      input: preview(input),
      ms: time(() => attempt(input)),
    }))
    .sort((a, b) => b.ms - a.ms);
}

/** Scanners over attacker-controlled text, each with its own time budget. */
const SCANNERS: ReadonlyArray<{
  readonly what: string;
  readonly scan: (input: string) => unknown;
  readonly inputs: () => string[];
  readonly budgetMs: number;
}> = [
  {
    what: "shell/analyzeShell",
    scan: analyzeShell,
    inputs: () => pathological(MAX_SCRIPT_LENGTH),
    budgetMs: 250,
  },
  {
    what: "jsonc/parseJsonc",
    scan: parseJsonc,
    inputs: () => [
      ...pathological(LENGTH),
      ",".repeat(LENGTH),
      "/*".repeat(LENGTH / 2),
      `[${", ".repeat(LENGTH / 2)}]`,
    ],
    budgetMs: 250,
  },
  {
    // pnpm-lock.yaml comes from untrusted repos; errors are fine, slowness is not.
    what: "yaml/parseYamlDocuments",
    scan: (input) => {
      try {
        return parseYamlDocuments(input);
      } catch (error) {
        if (error instanceof YamlError) return undefined;
        throw error;
      }
    },
    inputs: () => [
      ...pathological(LENGTH),
      `a: ${"{".repeat(LENGTH / 2)}`,
      `a:\n${"  b:\n".repeat(LENGTH / 8)}`,
      `a: [${"'x', ".repeat(LENGTH / 5)}]`,
      `${"k: v\n".repeat(LENGTH / 5)}`,
      `a: '${"''".repeat(LENGTH / 2)}'`,
    ],
    budgetMs: 250,
  },
  {
    what: "hidden/hiddenCode",
    scan: hiddenCode,
    inputs: () => [
      ...pathological(LENGTH),
      " \n".repeat(LENGTH / 2),
      `x${" ".repeat(LENGTH)}y`,
    ],
    budgetMs: 250,
  },
];

function main(): number {
  const regexRuns = timePatterns(
    [...CODE_PATTERNS, ...OBFUSCATION_PATTERNS],
    pathological(LENGTH),
  );
  const scannerRuns = SCANNERS.map(({ what, scan, inputs, budgetMs }) => ({
    runs: timeScanner(what, scan, inputs()),
    budgetMs,
  }));
  const slow = [
    ...regexRuns.filter((run) => run.ms > REGEX_BUDGET_MS),
    ...scannerRuns.flatMap(({ runs, budgetMs }) =>
      runs.filter((run) => run.ms > budgetMs),
    ),
  ];
  const worst = [...regexRuns, ...scannerRuns.flatMap(({ runs }) => runs)].sort(
    (a, b) => b.ms - a.ms,
  )[0];

  for (const s of slow)
    process.stderr.write(
      `SLOW ${s.what} on ${s.input}: ${s.ms.toFixed(1)} ms\n`,
    );
  process.stdout.write(
    `redos: ${CODE_PATTERNS.length + OBFUSCATION_PATTERNS.length} patterns × ${pathological(LENGTH).length} inputs + ${SCANNERS.length} scanners; ` +
      `worst ${worst?.ms.toFixed(1) ?? "0"} ms (${worst?.what ?? "-"})` +
      `${slow.length > 0 ? `; ${slow.length} over budget` : ""}\n`,
  );
  return slow.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();

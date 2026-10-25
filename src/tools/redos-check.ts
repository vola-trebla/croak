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
import { CODE_PATTERNS } from "../signals/code.ts";
import { parseJsonc } from "../signals/jsonc.ts";
import { analyzeShell, MAX_SCRIPT_LENGTH } from "../signals/shell.ts";

const LENGTH = 100_000;
const REGEX_BUDGET_MS = 100;
const SHELL_BUDGET_MS = 250;
const JSONC_BUDGET_MS = 250;

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

function timeShell(inputs: readonly string[]): Run[] {
  return inputs
    .map((input) => ({
      what: "shell/analyzeShell",
      input: preview(input),
      ms: time(() => analyzeShell(input)),
    }))
    .sort((a, b) => b.ms - a.ms);
}

function timeJsonc(inputs: readonly string[]): Run[] {
  const attempt = (input: string): void => {
    try {
      parseJsonc(input);
    } catch {
      // Rejecting hostile input is fine; only the time matters here.
    }
  };
  return inputs
    .map((input) => ({
      what: "jsonc/parseJsonc",
      input: preview(input),
      ms: time(() => attempt(input)),
    }))
    .sort((a, b) => b.ms - a.ms);
}

function main(): number {
  const regexRuns = timePatterns(CODE_PATTERNS, pathological(LENGTH));
  const shellRuns = timeShell(pathological(MAX_SCRIPT_LENGTH));
  const jsoncRuns = timeJsonc([
    ...pathological(LENGTH),
    ",".repeat(LENGTH),
    "/*".repeat(LENGTH / 2),
    `[${", ".repeat(LENGTH / 2)}]`,
  ]);
  const slow = [
    ...regexRuns.filter((run) => run.ms > REGEX_BUDGET_MS),
    ...shellRuns.filter((run) => run.ms > SHELL_BUDGET_MS),
    ...jsoncRuns.filter((run) => run.ms > JSONC_BUDGET_MS),
  ];
  const worst = [...regexRuns, ...shellRuns, ...jsoncRuns].sort(
    (a, b) => b.ms - a.ms,
  )[0];

  for (const s of slow)
    process.stderr.write(
      `SLOW ${s.what} on ${s.input}: ${s.ms.toFixed(1)} ms\n`,
    );
  process.stdout.write(
    `redos: ${CODE_PATTERNS.length} patterns × ${pathological(LENGTH).length} inputs + shell analyzer + JSONC parser; ` +
      `worst ${worst?.ms.toFixed(1) ?? "0"} ms (${worst?.what ?? "-"})` +
      `${slow.length > 0 ? `; ${slow.length} over budget` : ""}\n`,
  );
  return slow.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();

#!/usr/bin/env node
import { parseArgs } from "node:util";
import { renderScan, scanToJson } from "./repo-report.ts";
import { type ScanOutcome, ScanTargetError, scanRepoAt } from "./scan.ts";

export const VERSION = "0.0.0";

/**
 * 0 allow or warn (warnings are printed, the process succeeds),
 * 1 block, 2 usage error, 3 the scan could not complete — agents treat 3 as
 * a block (fail-closed).
 */
export const EXIT = { ok: 0, block: 1, usage: 2, incomplete: 3 } as const;

/** Conventional exit code for invalid command-line usage. */
export const EXIT_USAGE = EXIT.usage;

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** I/O the CLI depends on, injectable so run() stays testable without the filesystem. */
export interface CliDeps {
  readonly scan: (root: string) => ScanOutcome;
  /** Emoji output for a human in a terminal; plain text for pipes and CI. */
  readonly emoji: boolean;
}

const DEFAULT_DEPS: CliDeps = {
  scan: (root) => scanRepoAt(root),
  emoji: false,
};

const HELP = `croak 🐸 — croak before you install

Usage:
  croak repo [path]      scan a repo before you install or open it (default: .)
  croak --version
  croak --help

Options for repo:
  --json                 machine-readable report
  --plain                no emoji, even in a terminal

Exit codes: 0 allow/warn · 1 block · 2 usage error · 3 scan incomplete
`;

type ParseArgsError = TypeError & { readonly code: string };

function isParseArgsError(error: unknown): error is ParseArgsError {
  return (
    error instanceof TypeError &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS_")
  );
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      plain: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

const usageError = (message: string): CliResult => ({
  code: EXIT.usage,
  stdout: "",
  stderr: `croak: ${message}\n\n${HELP}`,
});

function exitCode(outcome: ScanOutcome): number {
  if (outcome.status === "incomplete") return EXIT.incomplete;
  return outcome.verdict === "block" ? EXIT.block : EXIT.ok;
}

/** Pure entry point: all I/O goes through deps. */
export function run(
  argv: readonly string[],
  deps: CliDeps = DEFAULT_DEPS,
): CliResult {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    // Usage mistakes are explained, not crashed on; anything else is a bug.
    if (!isParseArgsError(error)) throw error;
    return usageError(error.message);
  }
  const { values, positionals } = parsed;

  if (values.version === true)
    return { code: EXIT.ok, stdout: `${VERSION}\n`, stderr: "" };
  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) {
    return { code: EXIT.ok, stdout: HELP, stderr: "" };
  }
  if (command !== "repo") return usageError(`unknown command "${command}"`);
  if (rest.length > 1)
    return usageError(`repo takes one path, got ${rest.length}`);

  let outcome: ScanOutcome;
  try {
    outcome = deps.scan(rest[0] ?? ".");
  } catch (error) {
    if (!(error instanceof ScanTargetError)) throw error;
    return usageError(error.message);
  }

  const stdout =
    values.json === true
      ? scanToJson(outcome)
      : renderScan(outcome, { emoji: deps.emoji && values.plain !== true });
  return { code: exitCode(outcome), stdout, stderr: "" };
}

// Only touch the process when executed directly, not when imported by tests.
if (import.meta.main) {
  const result = run(process.argv.slice(2), {
    scan: (root) => scanRepoAt(root),
    emoji: process.stdout.isTTY === true,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

#!/usr/bin/env node
import { parseArgs } from "node:util";

export const VERSION = "0.0.0";

/** Conventional exit code for invalid command-line usage. */
export const EXIT_USAGE = 2;

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const HELP = `croak 🐸 — croak before you install

Usage:
  croak --version
  croak --help
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
    },
    strict: true,
  });
}

/** Pure entry point: easy to test, no process side effects. */
export function run(argv: readonly string[]): CliResult {
  let values: ReturnType<typeof parse>["values"];
  try {
    ({ values } = parse(argv));
  } catch (error) {
    // Usage mistakes are explained, not crashed on; anything else is a bug.
    if (!isParseArgsError(error)) throw error;
    return {
      code: EXIT_USAGE,
      stdout: "",
      stderr: `croak: ${error.message}\n\n${HELP}`,
    };
  }

  if (values.version === true)
    return { code: 0, stdout: `${VERSION}\n`, stderr: "" };
  return { code: 0, stdout: HELP, stderr: "" };
}

// Only touch the process when executed directly, not when imported by tests.
if (import.meta.main) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

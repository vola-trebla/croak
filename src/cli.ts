#!/usr/bin/env node
import { parseArgs } from "node:util";

export const VERSION = "0.0.0";

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
}

const HELP = `croak 🐸 — croak before you install

Usage:
  croak --version
  croak --help
`;

/** Pure entry point: easy to test, no process side effects. */
export function run(argv: readonly string[]): CliResult {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.version === true) return { code: 0, stdout: `${VERSION}\n` };
  return { code: 0, stdout: HELP };
}

// Only touch the process when executed directly, not when imported by tests.
if (import.meta.main) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exitCode = result.code;
}

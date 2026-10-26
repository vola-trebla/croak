#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runHook } from "./hook/hook.ts";
import {
  type ContentCache,
  codeFingerprint,
  fileContentCache,
} from "./install/content-cache.ts";
import { installedLockfile } from "./install/installed.ts";
import { suggestNames } from "./install/metadata.ts";
import { planToJson, renderPlan } from "./install/report.ts";
import {
  type PlanOutcome,
  planInstall,
  planInstallOnline,
} from "./install/scan.ts";
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
  /** Reads a lockfile for `croak plan`; defaults to the filesystem. */
  readonly readFile?: (path: string) => string;
  /** Registry access for `croak plan`; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Content findings cache for `croak plan` (none in tests). */
  readonly cache?: ContentCache;
}

const DEFAULT_DEPS: CliDeps = {
  scan: (root) => scanRepoAt(root),
  emoji: false,
};

const HELP = `croak 🐸 — croak before you install

Usage:
  croak plan --after <lock> [--before <lock|none> | --installed <project>]
             [--offline | --metadata-only] [--no-cache]
                         judge an install from the lockfile npm planned
  croak repo [path]      scan a repo before you install or open it (default: .)
  croak hook plan|decide the Claude Code hook's steps (used by croak-hook)
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
      before: { type: "string" },
      after: { type: "string" },
      offline: { type: "boolean" },
      "metadata-only": { type: "boolean" },
      "no-cache": { type: "boolean" },
      installed: { type: "string" },
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

function exitCode(outcome: ScanOutcome | PlanOutcome): number {
  if (outcome.status === "incomplete") return EXIT.incomplete;
  return outcome.verdict === "block" ? EXIT.block : EXIT.ok;
}

async function runPlan(
  values: {
    readonly before?: string | undefined;
    readonly after?: string | undefined;
    readonly json?: boolean | undefined;
    readonly plain?: boolean | undefined;
    readonly offline?: boolean | undefined;
    readonly "metadata-only"?: boolean | undefined;
    readonly "no-cache"?: boolean | undefined;
    readonly installed?: string | undefined;
  },
  rest: readonly string[],
  deps: CliDeps,
): Promise<CliResult> {
  if (rest.length > 0)
    return usageError(`plan takes no positional arguments, got ${rest.length}`);
  if (values.after === undefined)
    return usageError("plan needs --after <lockfile>");
  const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const load = (path: string): string | CliResult => {
    try {
      return read(path);
    } catch (error) {
      return usageError(
        `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const after = load(values.after);
  if (typeof after !== "string") return after;
  let before: string | undefined;
  if (values.installed !== undefined && values.before !== undefined)
    return usageError("plan takes --before or --installed, not both");
  if (values.installed !== undefined) {
    // What is really in node_modules, verified folder by folder (D34).
    before = installedLockfile(values.installed, (path) => {
      try {
        return read(path);
      } catch {
        return undefined;
      }
    });
  } else if (values.before !== undefined && values.before !== "none") {
    const text = load(values.before);
    if (typeof text !== "string") return text;
    before = text;
  }
  // --offline: lockfile signals only, no registry requests (tests, air-gapped CI).
  const outcome =
    values.offline === true
      ? planInstall(before, after)
      : await planInstallOnline(before, after, {
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(deps.cache === undefined || values["no-cache"] === true
            ? {}
            : { cache: deps.cache }),
          content: values["metadata-only"] !== true,
        });
  const stdout =
    values.json === true
      ? planToJson(outcome)
      : renderPlan(outcome, { emoji: deps.emoji && values.plain !== true });
  return { code: exitCode(outcome), stdout, stderr: "" };
}

/** Pure entry point: all I/O goes through deps. */
export async function run(
  argv: readonly string[],
  deps: CliDeps = DEFAULT_DEPS,
): Promise<CliResult> {
  // Suggestions for package names npm does not have (croak-install on E404).
  if (argv[0] === "suggest") {
    const lines = argv.slice(1).flatMap((spec) => {
      const names = suggestNames(decodeURIComponent(spec));
      return names.length === 0
        ? []
        : [
            `  ${spec}: did you mean ${names.map((n) => `\`${n}\``).join(", ")}?\n`,
          ];
    });
    return { code: EXIT.ok, stdout: lines.join(""), stderr: "" };
  }
  // The agent hook's two steps (scripts/croak-hook.sh); they read files only.
  if (argv[0] === "hook")
    return runHook(argv.slice(1), {
      readFile: deps.readFile ?? ((path) => readFileSync(path, "utf8")),
      exists: existsSync,
      home: homedir(),
      env: process.env,
    });
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
  if (command === "plan") return await runPlan(values, rest, deps);
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
  // Built on first use: fingerprinting croak's code costs a directory read.
  let cache: ContentCache | undefined;
  const contentCache = (): ContentCache => {
    cache ??= fileContentCache(
      join(
        process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
        "croak",
        "content",
      ),
      codeFingerprint(import.meta.dirname),
    );
    return cache;
  };
  const result = await run(process.argv.slice(2), {
    scan: (root) => scanRepoAt(root),
    emoji: process.stdout.isTTY === true,
    cache: {
      get: (integrity, label) => contentCache().get(integrity, label),
      set: (integrity, label, findings) =>
        contentCache().set(integrity, label, findings),
    },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { parseArgs } from "node:util";
import { runHook } from "./hook/hook.ts";
import {
  type ContentCache,
  codeFingerprint,
  fileContentCache,
} from "./install/content-cache.ts";
import {
  installedLockfile,
  installedPnpmLockfile,
} from "./install/installed.ts";
import { missingPackages, suggestNames } from "./install/metadata.ts";
import { npmScriptPolicy } from "./install/npm-scripts.ts";
import { pnpmBuildPolicy } from "./install/pnpm-builds.ts";
import { isPnpmLockfile, parsePnpmLockfile } from "./install/pnpm-lockfile.ts";
import {
  pnpmfileFindings,
  projectScriptFindings,
  workspaceMembers,
} from "./install/project.ts";
import { planToJson, renderPlan } from "./install/report.ts";
import {
  SanitizeError,
  sanitizePnpmWorkspace,
  sanitizeRootManifest,
} from "./install/sanitize.ts";
import {
  type PlanOutcome,
  planInstall,
  planInstallOnline,
} from "./install/scan.ts";
import { workspaceRoot } from "./install/workspace.ts";
import { anthropicTriage, DEFAULT_MODEL } from "./llm/client.ts";
import type { LlmOptions } from "./llm/plan-step.ts";
import { renderScan, scanToJson } from "./repo-report.ts";
import { type ScanOutcome, ScanTargetError, scanRepoAt } from "./scan.ts";
import { aggregate, type Finding } from "./verdict.ts";

export const VERSION = "0.1.4";

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
  /** The model for `croak plan --llm`; undefined when no API key is set. */
  readonly llm?: LlmOptions;
}

const DEFAULT_DEPS: CliDeps = {
  scan: (root) => scanRepoAt(root),
  emoji: false,
};

const HELP = `croak 🐸 — croak before you install

Usage:
  croak plan --after <lock> [--before <lock|none> | --installed <project>] [--project <dir>] [--member <dir>] [--llm]
             [--pnpm-builds <dir> [--pnpm-version <v>]]
             [--npm-scripts <dir> --npm-version <v> [--npm-allow-scripts <list>] [--npm-allow-all]]
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
      project: { type: "string" },
      member: { type: "string" },
      llm: { type: "boolean" },
      "pnpm-builds": { type: "string" },
      "pnpm-version": { type: "string" },
      "npm-scripts": { type: "string" },
      "npm-version": { type: "string" },
      "npm-allow-scripts": { type: "string" },
      "npm-allow-all": { type: "boolean" },
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
    readonly project?: string | undefined;
    readonly member?: string | undefined;
    readonly llm?: boolean | undefined;
    readonly "pnpm-builds"?: string | undefined;
    readonly "pnpm-version"?: string | undefined;
    readonly "npm-scripts"?: string | undefined;
    readonly "npm-version"?: string | undefined;
    readonly "npm-allow-scripts"?: string | undefined;
    readonly "npm-allow-all"?: boolean | undefined;
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
    const tryRead = (path: string): string | undefined => {
      try {
        return read(path);
      } catch {
        return undefined;
      }
    };
    // The installed tree of the manager that wrote the plan (D38).
    before = isPnpmLockfile(after)
      ? installedPnpmLockfile(
          values.installed,
          tryRead,
          (dir) => {
            try {
              return readdirSync(dir);
            } catch {
              return [];
            }
          },
          parsePnpmLockfile,
        )
      : installedLockfile(values.installed, tryRead);
  } else if (values.before !== undefined && values.before !== "none") {
    const text = load(values.before);
    if (typeof text !== "string") return text;
    before = text;
  }
  // The package manager's own rule for whose install scripts run, from the
  // project's settings: pnpm 10+ (D38), npm 12+ (D56).
  const buildsDir = values["pnpm-builds"];
  const scriptsDir = values["npm-scripts"];
  if (buildsDir !== undefined && scriptsDir !== undefined)
    return usageError(
      "--pnpm-builds and --npm-scripts: pick one package manager",
    );
  const readIn = (dir: string, file: string): string | undefined => {
    try {
      return read(`${dir}/${file}`);
    } catch {
      return undefined;
    }
  };
  const pnpmRule =
    buildsDir === undefined || values["pnpm-version"] === undefined
      ? undefined
      : pnpmBuildPolicy(
          {
            packageJson: readIn(buildsDir, "package.json"),
            workspaceYaml: readIn(buildsDir, "pnpm-workspace.yaml"),
          },
          values["pnpm-version"],
        );
  const npmRule =
    scriptsDir === undefined || values["npm-version"] === undefined
      ? undefined
      : npmScriptPolicy(
          readIn(scriptsDir, "package.json"),
          values["npm-version"],
          {
            allowScripts: (values["npm-allow-scripts"] ?? "")
              .split(/[\s,]+/)
              .filter((name) => name !== ""),
            allowAll: values["npm-allow-all"] === true,
          },
        );
  const builds =
    pnpmRule !== undefined
      ? { manager: "pnpm" as const, mayRun: pnpmRule }
      : npmRule !== undefined
        ? { manager: "npm" as const, mayRun: npmRule }
        : undefined;
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
          ...(builds === undefined ? {} : { builds }),
          ...(values.llm === true && deps.llm !== undefined
            ? { llm: deps.llm }
            : {}),
        });
  // --llm without a key: the rules decide, and the report says the model did not run.
  const llmMissing: Finding[] =
    values.llm === true && deps.llm === undefined && values.offline !== true
      ? [
          {
            ruleId: "llm/triage",
            severity: "info",
            file: "croak",
            message:
              "--llm was asked for, but ANTHROPIC_API_KEY is not set: rules only",
          },
        ]
      : [];
  const tryRead = (path: string): string | undefined => {
    try {
      return read(path);
    } catch {
      return undefined;
    }
  };
  const projectFs = {
    read: tryRead,
    kind: (path: string) => {
      try {
        const stats = lstatSync(path);
        const kind: "symlink" | "file" | "other" = stats.isSymbolicLink()
          ? "symlink"
          : stats.isFile()
            ? "file"
            : "other";
        return { kind, size: stats.size };
      } catch {
        return undefined;
      }
    },
  };
  // A plain npm install or npm ci also runs the project's own install scripts
  // (D35); pnpm runs the project's pnpmfile and config dependencies on every
  // install (D39).
  const project = values.project;
  const extra: Finding[] = [
    ...llmMissing,
    // The pnpmfile check needs only the project; the version is for the build rule.
    ...(buildsDir === undefined ? [] : pnpmfileFindings(buildsDir, projectFs)),
    ...(project === undefined || outcome.status !== "complete"
      ? []
      : projectScriptFindings(project, projectFs, {
          // The plan's lockfile parsed, so its members can be read (M6 review).
          members: workspaceMembers(after),
          pnpm: buildsDir !== undefined,
        })),
  ];
  // The folder the install ran in must be a member of the workspace the plan
  // was made at; otherwise the package manager installs elsewhere (M6 review).
  const member = values.member;
  const notMember =
    member !== undefined &&
    outcome.status === "complete" &&
    !workspaceMembers(after).includes(posix.normalize(member));
  const judged: PlanOutcome = notMember
    ? {
        status: "incomplete",
        reason: `${member} is inside a workspace that does not list it as a member, so the install would not run where croak planned it`,
        durationMs: outcome.durationMs,
      }
    : outcome.status !== "complete" || extra.length === 0
      ? outcome
      : (() => {
          const findings = [...extra, ...outcome.findings];
          return { ...outcome, findings, verdict: aggregate(findings) };
        })();
  const stdout =
    values.json === true
      ? planToJson(judged)
      : renderPlan(judged, { emoji: deps.emoji && values.plain !== true });
  return { code: exitCode(judged), stdout, stderr: "" };
}

/** Pure entry point: all I/O goes through deps. */
export async function run(
  argv: readonly string[],
  deps: CliDeps = DEFAULT_DEPS,
): Promise<CliResult> {
  // What the planning wrapper may hand to pnpm from an untrusted project (D38).
  if (argv[0] === "sanitize") {
    const [, kind, file] = argv;
    if (
      file === undefined ||
      (kind !== "root-manifest" && kind !== "pnpm-workspace")
    )
      return usageError(
        "usage: croak sanitize root-manifest|pnpm-workspace <file>",
      );
    const read =
      deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    try {
      const text = read(file);
      return {
        code: EXIT.ok,
        stdout:
          kind === "root-manifest"
            ? sanitizeRootManifest(text)
            : sanitizePnpmWorkspace(text),
        stderr: "",
      };
    } catch (error) {
      if (error instanceof SanitizeError) return usageError(error.message);
      throw error;
    }
  }
  // The workspace root croak-install plans at (D38): the same reading as the hook's.
  if (argv[0] === "workspace-root") {
    const [, manager, dir] = argv;
    if (dir === undefined || (manager !== "npm" && manager !== "pnpm"))
      return usageError("usage: croak workspace-root npm|pnpm <dir>");
    const root = workspaceRoot(dir, manager, {
      exists: existsSync,
      readFile: deps.readFile ?? ((path) => readFileSync(path, "utf8")),
    });
    return {
      code: EXIT.ok,
      stdout: root === undefined ? "" : `${root}\n`,
      stderr: "",
    };
  }
  // The packages a failed plan could not find, with suggestions
  // (croak-install on a 404, npm or pnpm).
  if (argv[0] === "suggest") {
    if (argv[1] !== "--log" || argv[2] === undefined)
      return usageError("usage: croak suggest --log <package manager log>");
    const read =
      deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    const lines = missingPackages(read(argv[2])).map((name) => {
      const names = suggestNames(name);
      return names.length === 0
        ? `  ${name}: not on npm\n`
        : `  ${name}: not on npm; did you mean ${names.map((n) => `\`${n}\``).join(", ")}?\n`;
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
  const key = process.env.ANTHROPIC_API_KEY;
  const result = await run(process.argv.slice(2), {
    scan: (root) => scanRepoAt(root),
    emoji: process.stdout.isTTY === true,
    ...(key === undefined || key === ""
      ? {}
      : {
          llm: { model: DEFAULT_MODEL, triage: anthropicTriage(key) },
        }),
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

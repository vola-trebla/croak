import { posix } from "node:path";
import { type InstallIntent, installIntents } from "./install-commands.ts";

/**
 * The Claude Code PreToolUse hook, in two pure steps around the shell script
 * that runs croak-install (croak itself never spawns, D24):
 *   plan   — the hook's JSON input → install intents → checks, one per line
 *   decide — the checks' results → deny / ask / nothing (D20, D32)
 * Silence lets the command through Claude Code's normal permission flow;
 * croak never grants a permission.
 */

export type CheckMode = "project" | "update" | "ci" | "empty";

export interface Check {
  readonly id: number;
  readonly mode: CheckMode;
  readonly dir: string;
  readonly packages: readonly string[];
  /** What the agent asked for, for the reason text. */
  readonly label: string;
}

export interface HookPlan {
  readonly intents: readonly InstallIntent[];
  readonly checks: readonly Check[];
}

export interface HookDeps {
  readonly readFile: (path: string) => string;
  readonly exists: (path: string) => boolean;
  readonly home: string;
  /** The environment npm will see (npm_config_* settings). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class HookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Bash command and directory from a PreToolUse event, or undefined for other tools. */
export function hookCommand(
  input: string,
): { command: string; cwd: string } | undefined {
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    throw new HookInputError("the hook input is not JSON");
  }
  if (!isRecord(data))
    throw new HookInputError("the hook input is not an object");
  if (data.tool_name !== "Bash") return undefined;
  const command = isRecord(data.tool_input)
    ? data.tool_input.command
    : undefined;
  if (
    typeof command !== "string" ||
    typeof data.cwd !== "string" ||
    !data.cwd.startsWith("/")
  )
    throw new HookInputError(
      "the hook input has no Bash command or absolute cwd",
    );
  return { command, cwd: data.cwd };
}

/** Text that goes to the shell as one tab-separated field. */
const SAFE = /^[^\t\n\r\0]+$/;
const isSafeSpec = (spec: string): boolean =>
  SAFE.test(spec) && !spec.startsWith("-");

/**
 * npm's local prefix: the nearest directory, from `dir` up, with a
 * package.json or a node_modules folder (as @npmcli/config does); `dir` itself
 * when there is none. That is where npm installs, not where the agent is.
 */
export function npmPrefix(
  dir: string,
  exists: (path: string) => boolean,
): string {
  for (let at = dir; ; at = posix.dirname(at)) {
    if (
      exists(posix.join(at, "package.json")) ||
      exists(posix.join(at, "node_modules"))
    )
      return at;
    if (at === "/") return dir;
  }
}

function readJson(path: string, deps: HookDeps): unknown {
  if (!deps.exists(path)) return undefined;
  try {
    return JSON.parse(deps.readFile(path));
  } catch {
    return undefined; // npm would fail on it too; it hides no install
  }
}

/** The directory of a package.json with workspaces, from `prefix` up (D34: not supported yet). */
function workspaceRoot(prefix: string, deps: HookDeps): string | undefined {
  for (let at = prefix; ; at = posix.dirname(at)) {
    const manifest = readJson(posix.join(at, "package.json"), deps);
    if (isRecord(manifest) && manifest.workspaces !== undefined) return at;
    if (at === "/") return undefined;
  }
}

const PUBLIC_REGISTRY = /^https:\/\/registry\.npmjs\.org\/?$/;
const REGISTRY_KEY = /(?:^|:)registry$|^replace-registry-host$/;
/**
 * Keys that load another config croak would not read, or change what npm runs
 * scripts and git with: with them, a warning the user approves would still run
 * the repo's own shell, preload or binary.
 */
const RUNNER_KEY =
  /^(?:userconfig|globalconfig|script-shell|node-options|shell|git|init-module)$/;

/** Where npm config sends npm somewhere croak does not check (D34), or undefined. */
function foreignRegistry(prefix: string, deps: HookDeps): string | undefined {
  const env = Object.entries(deps.env ?? {});
  // npm exports npm_config_userconfig when it launches a program; the file it
  // names is checked like any other npmrc, rather than refused outright.
  const named = env
    .filter(([key]) => /^npm_config_(?:userconfig|globalconfig)$/i.test(key))
    .map(([, value]) => value ?? "");
  const project = posix.join(prefix, ".npmrc");
  for (const file of [project, posix.join(deps.home, ".npmrc"), ...named]) {
    if (file === "" || !deps.exists(file)) continue;
    let text: string;
    try {
      text = deps.readFile(file);
    } catch {
      return `${file} cannot be read`;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || /^[;#]/.test(line)) continue;
      // ini sections group keys croak does not read: refuse rather than guess.
      if (line.startsWith("[")) return `${file} uses [sections]`;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      // Quotes around a key or value are stripped, as npm's ini parser does.
      const unquote = (part: string): string =>
        part.trim().replace(/^(["'])(.*)\1$/, "$2");
      const key = unquote(line.slice(0, eq));
      const value = unquote(line.slice(eq + 1));
      if (REGISTRY_KEY.test(key) && !PUBLIC_REGISTRY.test(value))
        return `${file} sets ${key}`;
      // The project's npmrc comes with the repo; the user's own files do not.
      if (file === project && RUNNER_KEY.test(key))
        return `${file} sets ${key}, which changes what npm runs`;
    }
  }
  for (const [key, value] of env) {
    const name = key.toLowerCase();
    if (
      name.startsWith("npm_config_") &&
      REGISTRY_KEY.test(name.slice(11).replace(/_/g, "-")) &&
      !PUBLIC_REGISTRY.test(value ?? "")
    )
      return `${key} is set`;
  }
  return undefined;
}

export function hookPlan(input: string, deps: HookDeps): HookPlan {
  const target = hookCommand(input);
  if (target === undefined) return { intents: [], checks: [] };
  const intents: InstallIntent[] = [];
  const checks: Check[] = [];
  const unchecked = (command: string, reason: string): void => {
    intents.push({ kind: "unchecked", command, reason });
  };
  for (const intent of installIntents(target.command, target.cwd, deps.home)) {
    if (intent.kind === "unchecked") {
      intents.push(intent);
      continue;
    }
    const packages = "packages" in intent ? intent.packages : [];
    const verb = {
      install: "npm install",
      update: "npm update",
      ci: "npm ci",
      run: "npx",
    }[intent.kind];
    const label = [verb, ...packages, "in", intent.dir].join(" ");
    if (!SAFE.test(intent.dir) || !packages.every(isSafeSpec)) {
      unchecked(label, "a package name or path in it cannot be checked safely");
      continue;
    }
    if (!deps.exists(intent.dir)) {
      unchecked(
        label,
        "its directory does not exist yet: create it in one command and install in the next, so croak can check the install",
      );
      continue;
    }
    const prefix = npmPrefix(intent.dir, deps.exists);
    const registry = foreignRegistry(prefix, deps);
    if (registry !== undefined) {
      unchecked(
        label,
        `npm here uses a registry croak does not check (${registry}); croak checks the public npm registry only`,
      );
      continue;
    }
    const global = intent.kind === "install" && intent.global;
    if (intent.kind !== "run" && !global) {
      const root = workspaceRoot(prefix, deps);
      if (root !== undefined) {
        unchecked(
          label,
          `${root} uses npm workspaces, which croak does not check yet`,
        );
        continue;
      }
      if (deps.exists(posix.join(prefix, "npm-shrinkwrap.json"))) {
        unchecked(
          label,
          "the project has an npm-shrinkwrap.json, which croak does not check yet",
        );
        continue;
      }
    }
    let mode: CheckMode;
    let specs = packages;
    if (intent.kind === "ci") mode = "ci";
    else if (intent.kind === "run") {
      // npx runs the prefix's own bin when it has one: no download.
      specs = packages.filter(
        (spec) =>
          spec.includes("@", spec.startsWith("@") ? 1 : 0) ||
          spec.includes("/") ||
          !deps.exists(posix.join(prefix, "node_modules", ".bin", spec)),
      );
      if (specs.length === 0) continue;
      mode = "empty";
    } else if (global) mode = "empty";
    else if (deps.exists(posix.join(prefix, "package.json")))
      mode = intent.kind === "update" ? "update" : "project";
    else if (packages.length > 0) mode = "empty";
    else continue; // npm install without a package.json installs nothing
    intents.push(intent);
    checks.push({
      id: checks.length + 1,
      mode,
      dir: mode === "empty" ? intent.dir : prefix,
      packages: specs,
      label,
    });
  }
  return { intents, checks };
}

/** One line per check for the shell: check <id> <mode> <dir> <package>… (tab-separated). */
export function planLines(plan: HookPlan): string {
  return plan.checks
    .map((c) =>
      ["check", String(c.id), c.mode, c.dir, ...c.packages].join("\t"),
    )
    .map((line) => `${line}\n`)
    .join("");
}

export interface CheckResult {
  readonly check: Check;
  /** croak-install's exit code, or undefined when the shell could not run it. */
  readonly code: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "deny" | "ask";
    readonly permissionDecisionReason: string;
  };
}

const MAX_FINDINGS = 6;
const DO_NOT_BYPASS =
  "Do not work around this check (another package manager, a different command, or editing files to install it); tell the user what croak found and let them decide.";

interface Judged {
  readonly verdict: "allow" | "warn" | "block";
  readonly lines: readonly string[];
}

/** One check's result as a verdict, with the findings worth showing. */
function judge(result: CheckResult): Judged {
  // croak-install's own lines (and its did-you-mean hints) say more than npm's log.
  const tail = (text: string): string => {
    const lines = text.trim().split("\n");
    const own = lines.filter((l) =>
      /^croak-install:|did you mean/.test(l.trim()),
    );
    return (own.length > 0 ? own : lines.slice(-4))
      .map((l) => l.trim())
      .join(" ")
      .slice(0, 400);
  };
  if (result.code === 2 || result.code === undefined || result.code > 3)
    return {
      verdict: "block",
      lines: [tail(result.stderr) || "croak-install could not run"],
    };
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return {
      verdict: "block",
      lines: [
        `the check did not finish: ${tail(result.stderr) || "no report"}`,
      ],
    };
  }
  if (!isRecord(report) || report.status !== "complete")
    return {
      verdict: "block",
      lines: [
        `the check is incomplete: ${isRecord(report) && typeof report.reason === "string" ? report.reason : "unknown reason"}`,
      ],
    };
  const findings = Array.isArray(report.findings)
    ? report.findings.filter(isRecord)
    : [];
  const shown = findings
    .filter((f) => f.severity === "block" || f.severity === "warn")
    .sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1,
    );
  const lines = shown
    .slice(0, MAX_FINDINGS)
    .map(
      (f) =>
        `${f.severity === "block" ? "🔴" : "🟡"} ${String(f.file)} ${String(f.ruleId)}: ${String(f.message)}`,
    );
  if (shown.length > MAX_FINDINGS)
    lines.push(
      `…and ${shown.length - MAX_FINDINGS} more (run croak-install yourself to see all)`,
    );
  const verdict =
    report.verdict === "block" || report.verdict === "warn"
      ? report.verdict
      : "allow";
  return { verdict, lines };
}

export function hookDecide(
  intents: readonly InstallIntent[],
  results: readonly CheckResult[],
): HookOutput | undefined {
  const blocked: string[] = [];
  const warned: string[] = [];
  for (const intent of intents)
    if (intent.kind === "unchecked")
      blocked.push(
        `${intent.command.slice(0, 120)}: not checked, because ${intent.reason}.`,
      );
  for (const result of results) {
    const { verdict, lines } = judge(result);
    const entry = [
      `${result.check.label}:`,
      ...lines.map((l) => `  ${l}`),
    ].join("\n");
    if (verdict === "block") blocked.push(entry);
    else if (verdict === "warn") warned.push(entry);
  }
  const output = (
    permissionDecision: "deny" | "ask",
    reason: string,
  ): HookOutput => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  });
  if (blocked.length > 0)
    return output(
      "deny",
      `🐸 croak blocked this command before it ran.\n${[...blocked, ...warned].join("\n")}\n${DO_NOT_BYPASS}`,
    );
  if (warned.length > 0)
    return output(
      "ask",
      `🐸 croak found things to review before this install runs (not a safe verdict):\n${warned.join("\n")}`,
    );
  return undefined;
}

/**
 * `croak hook plan <input.json>` prints the plan: a `plan <json>` line, then
 * the check lines. `croak hook decide <work>` reads that plan and each
 * check's <id>.code / <id>.out / <id>.err from the work directory and prints
 * the hook output, or nothing. Any error is the caller's cue to deny.
 */
export function runHook(
  args: readonly string[],
  deps: HookDeps,
): { code: number; stdout: string; stderr: string } {
  const [step, path] = args;
  if (path === undefined || (step !== "plan" && step !== "decide"))
    return {
      code: 2,
      stdout: "",
      stderr:
        "usage: croak hook plan <input.json> | croak hook decide <work-dir>\n",
    };
  try {
    return step === "plan" ? planStep(path, deps) : decideStep(path, deps);
  } catch (error) {
    if (!(error instanceof HookInputError)) throw error;
    return { code: 2, stdout: "", stderr: `${error.message}\n` };
  }
}

function planStep(
  path: string,
  deps: HookDeps,
): { code: number; stdout: string; stderr: string } {
  const plan = hookPlan(deps.readFile(path), deps);
  return {
    code: 0,
    stdout: `plan\t${JSON.stringify(plan)}\n${planLines(plan)}`,
    stderr: "",
  };
}

function decideStep(
  path: string,
  deps: HookDeps,
): { code: number; stdout: string; stderr: string } {
  const first = deps.readFile(posix.join(path, "plan")).split("\n")[0] ?? "";
  if (!first.startsWith("plan\t"))
    throw new HookInputError("the plan file is missing its plan line");
  const plan = JSON.parse(first.slice("plan\t".length)) as HookPlan;
  const read = (name: string): string | undefined => {
    try {
      return deps.readFile(posix.join(path, name));
    } catch {
      return undefined; // a missing result is judged as a check that did not run
    }
  };
  const results = plan.checks.map((check): CheckResult => {
    const code = Number.parseInt(read(`${check.id}.code`) ?? "", 10);
    return {
      check,
      code: Number.isNaN(code) ? undefined : code,
      stdout: read(`${check.id}.out`) ?? "",
      stderr: read(`${check.id}.err`) ?? "",
    };
  });
  const output = hookDecide(plan.intents, results);
  return {
    code: 0,
    stdout: output === undefined ? "" : `${JSON.stringify(output)}\n`,
    stderr: "",
  };
}

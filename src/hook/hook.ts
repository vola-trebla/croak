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

export type CheckMode = "project" | "ci" | "empty";

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

/** npx runs a local bin when the project has it: no download, nothing to check. */
function localBin(
  dir: string,
  spec: string,
  exists: (path: string) => boolean,
): boolean {
  if (spec.includes("@", spec.startsWith("@") ? 1 : 0) || spec.includes("/"))
    return false;
  for (let at = dir; ; at = posix.dirname(at)) {
    if (exists(posix.join(at, "node_modules", ".bin", spec))) return true;
    if (at === "/") return false;
  }
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
    const label =
      intent.kind === "ci"
        ? `npm ci in ${intent.dir}`
        : `${intent.kind === "run" ? "npx" : "npm install"} ${packages.join(" ")} in ${intent.dir}`.replace(
            "  ",
            " ",
          );
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
    let mode: CheckMode;
    let specs = packages;
    if (intent.kind === "ci") mode = "ci";
    else if (intent.kind === "run") {
      specs = packages.filter(
        (spec) => !localBin(intent.dir, spec, deps.exists),
      );
      if (specs.length === 0) continue;
      mode = "empty";
    } else if (intent.global) mode = "empty";
    else if (deps.exists(posix.join(intent.dir, "package.json")))
      mode = "project";
    else if (packages.length > 0) mode = "empty";
    else continue; // npm install without a package.json installs nothing
    intents.push(intent);
    checks.push({
      id: checks.length + 1,
      mode,
      dir: intent.dir,
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
  const tail = (text: string): string =>
    text.trim().split("\n").slice(-4).join(" ").slice(0, 400);
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

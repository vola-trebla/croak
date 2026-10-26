import { readFileSync } from "node:fs";
import { hookPlan } from "../hook/hook.ts";

/**
 * The agent-command check (M4): does the hook notice what an agent's command
 * would install, and leave ordinary commands alone? Offline: it scores the
 * hook's plan step on a fake project, not the package verdicts (the install
 * cases cover those).
 */

export type CommandAnswer = "check" | "deny" | "ignore";

export interface CommandCase {
  readonly command: string;
  readonly expect: CommandAnswer;
  readonly why: string;
  readonly knownGap?: boolean;
}

export interface CommandResult extends CommandCase {
  readonly got: CommandAnswer;
}

export interface CommandMetrics {
  /** Risky commands (check or deny expected) that the hook did not ignore. */
  readonly caught: { readonly hit: number; readonly total: number };
  /** Ordinary commands the hook left alone. */
  readonly untouched: { readonly hit: number; readonly total: number };
  /** Exactly the expected answer. */
  readonly exact: { readonly hit: number; readonly total: number };
}

/** A project at /repo with package.json and a local tsc, under a home at /home/u. */
const FAKE_FS = new Set([
  "/repo",
  "/repo/package.json",
  "/repo/frontend",
  "/repo/frontend/package.json",
  "/repo/server",
  "/repo/server/package.json",
  "/repo/node_modules/.bin/tsc",
]);

export function answer(command: string): CommandAnswer {
  const plan = hookPlan(
    JSON.stringify({
      tool_name: "Bash",
      cwd: "/repo",
      tool_input: { command },
    }),
    {
      readFile: () => {
        throw new Error("the command eval reads no files");
      },
      exists: (path) => FAKE_FS.has(path),
      home: "/home/u",
    },
  );
  if (plan.intents.some((i) => i.kind === "unchecked")) return "deny";
  return plan.checks.length > 0 ? "check" : "ignore";
}

export function loadCommandCases(path: string): CommandCase[] {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  const list =
    typeof data === "object" && data !== null && "commands" in data
      ? data.commands
      : undefined;
  if (
    !Array.isArray(list) ||
    !list.every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        typeof c.command === "string" &&
        ["check", "deny", "ignore"].includes(c.expect) &&
        typeof c.why === "string",
    )
  )
    throw new Error(`${path}: invalid agent command list`);
  return list as CommandCase[];
}

export function runCommandEval(cases: readonly CommandCase[]): {
  results: CommandResult[];
  metrics: CommandMetrics;
} {
  const results = cases.map((c) => ({ ...c, got: answer(c.command) }));
  const risky = results.filter((r) => r.expect !== "ignore");
  const ordinary = results.filter((r) => r.expect === "ignore");
  return {
    results,
    metrics: {
      caught: {
        hit: risky.filter((r) => r.got !== "ignore").length,
        total: risky.length,
      },
      untouched: {
        hit: ordinary.filter((r) => r.got === "ignore").length,
        total: ordinary.length,
      },
      exact: {
        hit: results.filter((r) => r.got === r.expect).length,
        total: results.length,
      },
    },
  };
}

export function renderCommandEval({
  results,
  metrics,
}: ReturnType<typeof runCommandEval>): string {
  const pct = ({ hit, total }: { hit: number; total: number }) =>
    total === 0 ? "n/a" : `${Math.round((hit / total) * 100)}%`;
  const misses = results.filter((r) => r.got !== r.expect);
  const lines = [
    "",
    `agent commands — ${results.length} (the hook's plan step, offline)`,
    `  caught      ${metrics.caught.hit}/${metrics.caught.total}  ${pct(metrics.caught)}`,
    `  untouched   ${metrics.untouched.hit}/${metrics.untouched.total}  ${pct(metrics.untouched)}`,
    `  exact       ${metrics.exact.hit}/${metrics.exact.total}  ${pct(metrics.exact)}`,
    ...misses.map(
      (r) =>
        `  ${r.knownGap === true ? "known gap" : "MISS     "}  expected ${r.expect.padEnd(6)} got ${r.got.padEnd(6)} ${r.command}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

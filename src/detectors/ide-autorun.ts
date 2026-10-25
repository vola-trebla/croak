import { posix } from "node:path";
import type { RepoSnapshot } from "../repo-snapshot.ts";
import { JsoncError, parseJsonc } from "../signals/jsonc.ts";
import { stripBom } from "../signals/text.ts";
import type { Finding } from "../verdict.ts";
import type { RepoDetector } from "./index.ts";
import { assessor } from "./lifecycle-script.ts";
import { isInNodeModules } from "./node-modules-present.ts";

const RULE = "repo/ide-autorun";
const TASKS_FILE = ".vscode/tasks.json";
const MAX_SHOWN = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const truncate = (text: string): string =>
  text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;

/** Lines (1-based) that mention folderOpen, in order: one per autorun task. */
function folderOpenLines(text: string): number[] {
  return text
    .split("\n")
    .flatMap((line, index) => (line.includes("folderOpen") ? [index + 1] : []));
}

/** The npm script a task runs, read from the package.json next to the .vscode folder. */
/** The package.json next to the .vscode folder: its directory and scripts. */
function manifestFor(
  repo: RepoSnapshot,
  tasksPath: string,
): { dir: string; scripts: Record<string, unknown> } {
  const folder = posix.dirname(posix.dirname(tasksPath));
  const dir = folder === "." ? "" : folder;
  const text = repo.read(dir === "" ? "package.json" : `${dir}/package.json`);
  if (text === undefined) return { dir, scripts: {} };
  try {
    const manifest: unknown = JSON.parse(stripBom(text));
    return {
      dir,
      scripts:
        isRecord(manifest) && isRecord(manifest.scripts)
          ? manifest.scripts
          : {},
    };
  } catch {
    // An unreadable package.json is reported by repo/lifecycle-script.
    return { dir, scripts: {} };
  }
}

function taskFinding(
  repo: RepoSnapshot,
  path: string,
  task: Record<string, unknown>,
  line: number | undefined,
  trigger: string,
): Finding {
  const label = asString(task.label) ?? "(unnamed task)";
  const presentation = isRecord(task.presentation) ? task.presentation : {};
  const hidden =
    presentation.reveal === "never" ? ", with its terminal hidden" : "";
  const at = line === undefined ? { file: path } : { file: path, line };

  if (task.type === "npm") {
    // Same analysis as install scripts: the script, the files it runs, and
    // the scripts it calls through npm run.
    const script = asString(task.script) ?? "";
    const { dir, scripts } = manifestFor(repo, path);
    const command = asString(scripts[script]);
    const assessment =
      command === undefined ? undefined : assessor(repo, dir, scripts)(command);
    const shown =
      command === undefined
        ? "not found in package.json"
        : `\`${truncate(command)}\``;
    const reasons =
      assessment !== undefined && assessment.reasons.length > 0
        ? `: ${assessment.reasons.join("; ")}`
        : "";
    return {
      ruleId: RULE,
      severity: assessment?.block === true ? "block" : "warn",
      ...at,
      message: `task "${label}" runs npm script "${script}" (${shown}) ${trigger}${hidden}${reasons}`,
    };
  }

  // shell, process, or no type: VS Code runs the command directly.
  const args = Array.isArray(task.args)
    ? task.args.filter((a): a is string => typeof a === "string")
    : [];
  const command = [asString(task.command) ?? "(command)", ...args].join(" ");
  return {
    ruleId: RULE,
    severity: "block",
    ...at,
    message: `task "${label}" runs \`${truncate(command)}\` automatically ${trigger}${hidden}`,
  };
}

const dependsOnLabels = (task: Record<string, unknown>): string[] => {
  const deps = task.dependsOn;
  if (typeof deps === "string") return [deps];
  return Array.isArray(deps)
    ? deps.filter((d): d is string => typeof d === "string")
    : [];
};

function tasksFindings(repo: RepoSnapshot, path: string): Finding[] {
  const text = repo.read(path);
  if (text === undefined) return [];
  let config: unknown;
  try {
    config = parseJsonc(stripBom(text));
  } catch (error) {
    if (!(error instanceof JsoncError)) throw error;
    return [
      {
        ruleId: RULE,
        severity: "warn",
        file: path,
        message: `tasks.json could not be parsed (${error.message}); VS Code may still run its tasks`,
      },
    ];
  }
  const tasks =
    isRecord(config) && Array.isArray(config.tasks)
      ? config.tasks.filter(isRecord)
      : [];
  const byLabel = new Map(
    tasks.flatMap((task) =>
      typeof task.label === "string" ? [[task.label, task] as const] : [],
    ),
  );
  const autorun = tasks.filter(
    (task) =>
      isRecord(task.runOptions) && task.runOptions.runOn === "folderOpen",
  );
  const lines = folderOpenLines(text);
  const findings = autorun.map((task, index) =>
    taskFinding(repo, path, task, lines[index], "when the folder is opened"),
  );

  // Tasks an autorun task depends on run first, just as automatically.
  const seen = new Set<Record<string, unknown>>(autorun);
  const queue = autorun.flatMap((task) =>
    dependsOnLabels(task).map((dep) => ({
      dep,
      parent: asString(task.label) ?? "",
    })),
  );
  while (queue.length > 0) {
    const next = queue.shift();
    const task = next === undefined ? undefined : byLabel.get(next.dep);
    if (next === undefined || task === undefined || seen.has(task)) continue;
    seen.add(task);
    findings.push(
      taskFinding(
        repo,
        path,
        task,
        undefined,
        `when the folder is opened (folder-open task "${next.parent}" depends on it)`,
      ),
    );
    queue.push(
      ...dependsOnLabels(task).map((dep) => ({ dep, parent: next.dep })),
    );
  }
  return findings;
}

/** VS Code tasks that run by themselves when the folder is opened. */
export const ideAutorun: RepoDetector = (repo) =>
  repo.entries
    .filter(
      (e) =>
        e.kind === "file" &&
        (e.path === TASKS_FILE || e.path.endsWith(`/${TASKS_FILE}`)) &&
        !isInNodeModules(e.path),
    )
    .flatMap((e) => tasksFindings(repo, e.path));

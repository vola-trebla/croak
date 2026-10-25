import { posix } from "node:path";
import type { RepoSnapshot } from "../repo-snapshot.ts";
import { JsoncError, parseJsonc } from "../signals/jsonc.ts";
import { analyzeShell } from "../signals/shell.ts";
import { stripBom } from "../signals/text.ts";
import type { Finding } from "../verdict.ts";
import type { RepoDetector } from "./index.ts";
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
function npmScript(
  repo: RepoSnapshot,
  tasksPath: string,
  script: string,
): string | undefined {
  const folder = posix.dirname(posix.dirname(tasksPath));
  const manifestPath =
    folder === "." ? "package.json" : `${folder}/package.json`;
  const text = repo.read(manifestPath);
  if (text === undefined) return undefined;
  try {
    const manifest: unknown = JSON.parse(stripBom(text));
    const scripts =
      isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
    return asString(scripts[script]);
  } catch {
    // An unreadable package.json is reported by repo/lifecycle-script.
    return undefined;
  }
}

function taskFinding(
  repo: RepoSnapshot,
  path: string,
  task: Record<string, unknown>,
  line: number | undefined,
): Finding {
  const label = asString(task.label) ?? "(unnamed task)";
  const presentation = isRecord(task.presentation) ? task.presentation : {};
  const hidden =
    presentation.reveal === "never" ? ", with its terminal hidden" : "";
  const at = line === undefined ? { file: path } : { file: path, line };

  if (task.type === "npm") {
    const script = asString(task.script) ?? "";
    const command = npmScript(repo, path, script);
    const dangerous =
      command !== undefined && analyzeShell(command).downloadExecute;
    const shown =
      command === undefined
        ? "not found in package.json"
        : `\`${truncate(command)}\``;
    return {
      ruleId: RULE,
      severity: dangerous ? "block" : "warn",
      ...at,
      message: `task "${label}" runs npm script "${script}" (${shown}) when the folder is opened${hidden}${dangerous ? "; the script downloads and executes code" : ""}`,
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
    message: `task "${label}" runs \`${truncate(command)}\` automatically when the folder is opened${hidden}`,
  };
}

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
  const autorun = tasks.filter(
    (task) =>
      isRecord(task.runOptions) && task.runOptions.runOn === "folderOpen",
  );
  const lines = folderOpenLines(text);
  return autorun.map((task, index) =>
    taskFinding(repo, path, task, lines[index]),
  );
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

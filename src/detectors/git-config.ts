import { posix } from "node:path";
import type { RepoSnapshot } from "../repo-snapshot.ts";
import { codeSignals, isSuspicious } from "../signals/code.ts";
import { type GitConfigEntry, parseGitConfig } from "../signals/git-config.ts";
import { analyzeShell } from "../signals/shell.ts";
import type { Finding, Severity } from "../verdict.ts";
import type { RepoDetector } from "./index.ts";
import { isInNodeModules } from "./node-modules-present.ts";

const RULE = "repo/git-config";
const LFS_FILTER = /^git-lfs (?:clean|smudge|filter-process)(?: -- %f)?$/;
const NAMED_HELPER = /^[A-Za-z0-9-]+$/;
const BOOLEAN = new Set([
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "1",
  "0",
  "",
]);
const MAX_SHOWN = 60;

interface Rule {
  readonly when: string;
  readonly severity: Severity;
}

const truncate = (text: string): string =>
  text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;

/** What git does with a setting, or undefined when the setting runs nothing. */
function classify({ section, key, value }: GitConfigEntry): Rule | undefined {
  const name = `${section.split(".")[0] ?? ""}.${key}`;
  if (section === "core" && key === "fsmonitor") {
    return BOOLEAN.has(value.toLowerCase())
      ? undefined
      : { when: "runs on every git status", severity: "block" };
  }
  if (section === "core" && key === "sshcommand")
    return { when: "runs on every fetch and push", severity: "block" };
  if (section === "core" && ["pager", "editor", "askpass"].includes(key)) {
    return { when: `runs as git's ${key}`, severity: "block" };
  }
  if (
    name === "sequence.editor" ||
    name === "gpg.program" ||
    (section.startsWith("gpg.") && key === "program")
  ) {
    return { when: "runs during rebase or signing", severity: "block" };
  }
  if (name === "diff.external")
    return { when: "runs on every git diff", severity: "block" };
  if (
    section.startsWith("filter.") &&
    ["clean", "smudge", "process"].includes(key)
  ) {
    // Git runs filter values through the shell: only the exact LFS command is benign.
    return LFS_FILTER.test(value)
      ? { when: "is a Git LFS filter", severity: "info" }
      : { when: "runs on checkout and add", severity: "block" };
  }
  if (name === "credential.helper") {
    // Only a bare helper name (osxkeychain, store, manager) is benign.
    return NAMED_HELPER.test(value)
      ? { when: "is a named credential helper", severity: "info" }
      : { when: "runs when git asks for credentials", severity: "block" };
  }
  if (
    section.startsWith("submodule.") &&
    key === "update" &&
    value.startsWith("!")
  ) {
    return { when: "runs on git submodule update", severity: "block" };
  }
  if (
    section.startsWith("diff.") &&
    (key === "textconv" || key === "command")
  ) {
    return {
      when: "runs on git diff and git log -p for files mapped in .gitattributes",
      severity: "block",
    };
  }
  if (section.startsWith("merge.") && key === "driver")
    return { when: "runs on merges", severity: "block" };
  if (section === "pager")
    return { when: `runs as the pager for git ${key}`, severity: "block" };
  if (section === "core" && key === "gitproxy")
    return { when: "runs on git:// fetches", severity: "block" };
  if (
    section.startsWith("remote.") &&
    (key === "uploadpack" || key === "receivepack")
  ) {
    return { when: "runs on fetch or push", severity: "block" };
  }
  if (
    (section.startsWith("difftool.") || section.startsWith("mergetool.")) &&
    key === "cmd"
  ) {
    return {
      when: "runs when the diff or merge tool is used",
      severity: "block",
    };
  }
  if (section === "core" && key === "hookspath")
    return { when: "moves git hooks to another directory", severity: "warn" };
  if (
    (section === "include" || section.startsWith("includeif.")) &&
    key === "path"
  ) {
    return { when: "pulls in another config file", severity: "warn" };
  }
  if (section === "alias" && value.startsWith("!"))
    return {
      when: "runs a shell command when the alias is used",
      severity: "warn",
    };
  return undefined;
}

function configFindings(repo: RepoSnapshot, path: string): Finding[] {
  return parseGitConfig(repo.read(path) ?? "").flatMap((entry) => {
    const rule = classify(entry);
    if (rule === undefined) return [];
    return [
      {
        ruleId: RULE,
        severity: rule.severity,
        file: path,
        line: entry.line,
        message: `${entry.section}.${entry.key} = \`${truncate(entry.value)}\` ${rule.when}`,
      },
    ];
  });
}

function hookFinding(repo: RepoSnapshot, path: string): Finding {
  const text = repo.read(path) ?? "";
  const suspicious =
    analyzeShell(text).downloadExecute ||
    isSuspicious(new Set(codeSignals(text).map((s) => s.signal)));
  return {
    ruleId: RULE,
    severity: suspicious ? "block" : "warn",
    file: path,
    message: `active git hook ${posix.basename(path)} runs automatically on git operations${suspicious ? " and downloads, executes, or exfiltrates" : ""}`,
  };
}

const isGitConfig = (path: string): boolean =>
  path === ".git/config" ||
  path.endsWith("/.git/config") ||
  posix.basename(path) === ".gitmodules";
const isActiveHook = (path: string): boolean =>
  /(?:^|\/)\.git\/hooks\/[^/]+$/.test(path) && !path.endsWith(".sample");

/** Git settings and hooks that make ordinary git commands run code (e.g. a zip-shipped .git). */
export const gitConfig: RepoDetector = (repo) =>
  repo.entries
    .filter((e) => e.kind === "file" && !isInNodeModules(e.path))
    .flatMap((e) => {
      if (isGitConfig(e.path)) return configFindings(repo, e.path);
      if (isActiveHook(e.path)) return [hookFinding(repo, e.path)];
      return [];
    });

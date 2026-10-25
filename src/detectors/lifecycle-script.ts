import { posix } from "node:path";
import type { RepoSnapshot } from "../repo-snapshot.ts";
import {
  type CodeSignal,
  codeSignals,
  describeSignals,
  isSuspicious,
} from "../signals/code.ts";
import { analyzeShell } from "../signals/shell.ts";
import type { Finding } from "../verdict.ts";
import type { RepoDetector } from "./index.ts";
import { isInNodeModules } from "./node-modules-present.ts";

const RULE = "repo/lifecycle-script";

/** Every script npm runs during `npm install` in the project itself. */
export const INSTALL_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
] as const;

/**
 * Tools that legitimately run on install. Recognizing one adds context (an
 * info note); it never lowers the verdict of anything else in the script.
 */
const KNOWN_TOOLS = new Set([
  // install-time tools
  "prisma",
  "husky",
  "patch-package",
  "simple-git-hooks",
  "lefthook",
  "ngcc",
  "nuxt",
  "nuxi",
  "svelte-kit",
  "astro",
  "playwright",
  "only-allow",
  "opencollective-postinstall",
  // build tools commonly run from prepare
  "tsc",
  "tsup",
  "vite",
  "rollup",
  "esbuild",
  "webpack",
  "turbo",
  "nx",
  "lerna",
  "unbuild",
  "swc",
  "babel",
  "rimraf",
  // harmless shell builtins
  "echo",
  "true",
  "exit",
  "printf",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const MAX_SCRIPT_DEPTH = 5;

const SHELL_DECODE =
  /\bbase64\s+(?:-d|-D|--decode)\b|\bopenssl\s+(?:enc|base64)\b[^|;&]*\s-d\b/;
const MAX_SHOWN = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const truncate = (text: string): string =>
  text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;

/** 1-based line of the "name": key in a manifest, if found. */
function scriptLine(manifest: string, name: string): number | undefined {
  const index = manifest
    .split("\n")
    .findIndex((line) => line.includes(`"${name}"`));
  return index === -1 ? undefined : index + 1;
}

interface Assessment {
  readonly block: boolean;
  readonly reasons: readonly string[];
  readonly knownTools: readonly string[];
}

/**
 * True when every command is a known tool or a package-manager call to a
 * script that is itself routine, and nothing else at all is going on: no
 * network, no local files, no inline code, no code signals. Anything unknown
 * or unresolved is not routine (D19).
 */
function isRoutine(
  command: string,
  scripts: Record<string, unknown>,
  depth = 0,
  visited: ReadonlySet<string> = new Set(),
): boolean {
  if (depth > MAX_SCRIPT_DEPTH) return false;
  const facts = analyzeShell(command);
  if (
    facts.unparsable ||
    facts.downloadExecute ||
    facts.network ||
    facts.localFiles.length > 0 ||
    facts.inlineCode.length > 0 ||
    codeSignals(command).length > 0 ||
    facts.commands.length === 0
  ) {
    return false;
  }
  const runs = new Set(facts.runScripts);
  const everyCommandKnown = facts.commands.every(
    (name) =>
      KNOWN_TOOLS.has(name) || (PACKAGE_MANAGERS.has(name) && runs.size > 0),
  );
  if (!everyCommandKnown) return false;
  return [...runs].every((name) => {
    const target = scripts[name];
    return (
      typeof target === "string" &&
      !visited.has(name) &&
      isRoutine(target, scripts, depth + 1, new Set([...visited, name]))
    );
  });
}

/** What the script's command does, including the files and inline code it runs. */
function assess(repo: RepoSnapshot, dir: string, command: string): Assessment {
  const facts = analyzeShell(command);
  if (facts.unparsable) {
    return {
      block: false,
      reasons: [
        "the command could not be parsed, so croak cannot tell what it runs",
      ],
      knownTools: [],
    };
  }

  const reasons: string[] = [];
  const signals = new Set<CodeSignal>();
  const absorb = (
    hits: ReturnType<typeof codeSignals>,
    where: string,
  ): void => {
    if (hits.length === 0) return;
    for (const hit of hits) signals.add(hit.signal);
    reasons.push(describeSignals(hits, where));
  };

  if (facts.downloadExecute) reasons.push("downloads and executes code");
  if (facts.network) {
    signals.add("network");
    reasons.push("uses the network");
  }
  if (SHELL_DECODE.test(command)) signals.add("decode");
  absorb(codeSignals(command), "the command");
  for (const code of facts.inlineCode) absorb(codeSignals(code), "inline code");

  for (const file of facts.localFiles) {
    const path = posix.normalize(posix.join(dir, file));
    if (path === ".." || path.startsWith("../")) {
      reasons.push(`runs ${file}, a path outside the repo`);
      continue;
    }
    const entry = repo.entries.find((e) => e.path === path);
    if (entry === undefined)
      reasons.push(`runs ${path}, which is not in the repo`);
    else if (entry.kind === "oversized")
      reasons.push(`runs ${path}, too large to scan`);
    else if (entry.kind === "symlink")
      reasons.push(`runs ${path}, a symlink croak does not follow`);
    else absorb(codeSignals(repo.read(path) ?? ""), path);
  }

  return {
    block: facts.downloadExecute || isSuspicious(signals),
    reasons,
    knownTools: [
      ...new Set(facts.commands.filter((name) => KNOWN_TOOLS.has(name))),
    ],
  };
}

function manifestFindings(repo: RepoSnapshot, path: string): Finding[] {
  const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
  const text = repo.read(path);
  if (text === undefined) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    // Not swallowed: an unreadable manifest is reported, the scan continues.
    return [
      {
        ruleId: RULE,
        severity: "warn",
        file: path,
        message:
          "package.json is not valid JSON; croak cannot see its install scripts",
      },
    ];
  }
  const scripts =
    isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
  const findings: Finding[] = [];

  for (const name of INSTALL_SCRIPTS) {
    const command = scripts[name];
    if (typeof command !== "string") continue;
    const { block, reasons, knownTools } = assess(repo, dir, command);
    const line = scriptLine(text, name);
    const at = line === undefined ? { file: path } : { file: path, line };
    if (!block && isRoutine(command, scripts)) {
      findings.push({
        ruleId: RULE,
        severity: "info",
        ...at,
        message: `${name} runs \`${truncate(command)}\` on install: known tools only, nothing suspicious`,
      });
      continue;
    }
    findings.push({
      ruleId: RULE,
      severity: block ? "block" : "warn",
      ...at,
      message: `${name} runs \`${truncate(command)}\` on install${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`,
    });
    for (const tool of knownTools) {
      findings.push({
        ruleId: RULE,
        severity: "info",
        ...at,
        message: `${name} uses ${tool}, a known install-time tool`,
      });
    }
  }

  // npm runs `node-gyp rebuild` for a package with binding.gyp and no install script of its own.
  const gyp = posix.join(dir, "binding.gyp");
  if (
    !("install" in scripts) &&
    !("preinstall" in scripts) &&
    repo.entries.some((e) => e.path === gyp)
  ) {
    findings.push({
      ruleId: RULE,
      severity: "warn",
      file: gyp,
      message:
        "binding.gyp makes npm run `node-gyp rebuild` on install; gyp files can run arbitrary build actions",
    });
  }
  return findings;
}

/** Install-time scripts in every package.json outside node_modules (workspaces run theirs too). */
export const lifecycleScript: RepoDetector = (repo) =>
  repo.entries
    .filter(
      (e) =>
        e.kind === "file" &&
        posix.basename(e.path) === "package.json" &&
        !isInNodeModules(e.path),
    )
    .flatMap((e) => manifestFindings(repo, e.path));

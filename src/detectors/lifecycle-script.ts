import { posix } from "node:path";
import type { RepoSnapshot } from "../repo-snapshot.ts";
import {
  type CodeSignal,
  codeSignals,
  describeSignals,
  isSuspicious,
} from "../signals/code.ts";
import { analyzeShell } from "../signals/shell.ts";
import { stripBom } from "../signals/text.ts";
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
  // runs after node_modules changes (npm docs)
  "dependencies",
] as const;

/** The only scripts npm runs for a package installed from the registry. */
export const DEPENDENCY_INSTALL_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
] as const;

/** node_modules/<name>/package.json or node_modules/@scope/<name>/package.json, at any depth. */
const BUNDLED_MANIFEST =
  /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/@][^/]*\/package\.json$/;

export interface LifecyclePolicy {
  /** Which code-signal combinations block. */
  readonly suspicious: (signals: ReadonlySet<CodeSignal>) => boolean;
  /** Which scripts run on install. */
  readonly scripts: readonly string[];
  /**
   * repo: every package.json outside node_modules (workspaces run theirs).
   * package: the package's own package.json and those of its bundled
   * dependencies (node_modules/<name>/, at any depth), whose install scripts
   * npm runs too. root: only the top-level package.json (the project an
   * install runs in).
   */
  readonly manifests: "repo" | "package" | "root";
}

/**
 * Tools that run no project code: their install-time use can be an info note
 * (D19). Everything they do is decided by the tool, not by files in the repo.
 */
const INERT_TOOLS = new Set([
  "husky",
  "simple-git-hooks",
  "lefthook",
  "only-allow",
  "opencollective-postinstall",
  "playwright",
  "tsc",
  "esbuild",
  "swc",
  "echo",
  "true",
  "exit",
  "printf",
]);

/**
 * Recognized install-time tools that execute code from the repo — a JS/TS
 * config, workspace tasks, a generator, or patches. Recognizing one adds a
 * note; the script stays a warning.
 */
const EXECUTING_TOOLS = new Set([
  "prisma",
  "vite",
  "webpack",
  "rollup",
  "tsup",
  "unbuild",
  "babel",
  "nuxt",
  "nuxi",
  "svelte-kit",
  "astro",
  "ngcc",
  "turbo",
  "nx",
  "lerna",
  "patch-package",
  "rimraf",
]);

const KNOWN_TOOLS = new Set([...INERT_TOOLS, ...EXECUTING_TOOLS]);
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

/** 1-based line of `"name":` inside the manifest's "scripts" object, if found. */
function scriptLine(manifest: string, name: string): number | undefined {
  const lines = manifest.split("\n");
  const scripts = lines.findIndex((line) => /"scripts"\s*:/.test(line));
  const key = `"${name}"`;
  const index = lines.findIndex(
    (line, i) =>
      i >= Math.max(scripts, 0) &&
      line.includes(key) &&
      /"\s*:/.test(line.slice(line.indexOf(key))),
  );
  return index === -1 ? undefined : index + 1;
}

interface Assessment {
  readonly block: boolean;
  readonly reasons: readonly string[];
  readonly knownTools: readonly string[];
  readonly signals: ReadonlySet<CodeSignal>;
}

/**
 * Decides whether install-time commands are routine (D19): every command is an
 * inert tool or a package-manager call that runs a script which is itself
 * routine — including npm's pre/post hooks for that script — and nothing else
 * is present: no network, local files, inline code, code signals, environment
 * assignments, redirects, wrappers, or workspace-wide runs. Results are
 * memoized per script name, so a layered script graph costs linear time.
 */
function routineChecker(
  scripts: Record<string, unknown>,
): (command: string) => boolean {
  const memo = new Map<string, boolean>();

  const scriptIsRoutine = (name: string, depth: number): boolean => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    memo.set(name, false); // a cycle back here is not routine
    const body = scripts[name];
    const result =
      typeof body === "string" &&
      commandIsRoutine(body, depth + 1) &&
      [`pre${name}`, `post${name}`].every(
        (hook) => !(hook in scripts) || scriptIsRoutine(hook, depth + 1),
      );
    memo.set(name, result);
    return result;
  };

  const commandIsRoutine = (command: string, depth: number): boolean => {
    if (depth > MAX_SCRIPT_DEPTH) return false;
    const facts = analyzeShell(command);
    if (
      facts.unparsable ||
      facts.downloadExecute ||
      facts.network ||
      facts.localFiles.length > 0 ||
      facts.inlineCode.length > 0 ||
      facts.modifiers.length > 0 ||
      codeSignals(command).length > 0 ||
      facts.commands.length === 0
    ) {
      return false;
    }
    // Every package-manager call must run a script: `npm install x` does not.
    const pmCalls = facts.commands.filter((name) =>
      PACKAGE_MANAGERS.has(name),
    ).length;
    if (pmCalls !== facts.runScripts.length) return false;
    if (
      !facts.commands.every(
        (name) => INERT_TOOLS.has(name) || PACKAGE_MANAGERS.has(name),
      )
    )
      return false;
    return facts.runScripts.every((name) => scriptIsRoutine(name, depth));
  };

  return (command) => commandIsRoutine(command, 0);
}

/**
 * What a script's command does, including the files and inline code it runs
 * and the package.json scripts it calls through `npm run` (with npm's pre/post
 * hooks), recursively. Signals are combined across the whole call graph, so
 * an attack split across two scripts still blocks. Memoized per script name.
 */
export function assessor(
  repo: RepoSnapshot,
  dir: string,
  scripts: Record<string, unknown>,
  suspicious: (signals: ReadonlySet<CodeSignal>) => boolean = isSuspicious,
): (command: string) => Assessment {
  const memo = new Map<string, Assessment>();
  const empty: Assessment = {
    block: false,
    reasons: [],
    knownTools: [],
    signals: new Set(),
  };

  const assessScript = (name: string, depth: number): Assessment => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    memo.set(name, empty); // break cycles
    const body = scripts[name];
    const result =
      typeof body !== "string"
        ? {
            ...empty,
            reasons: [`calls script "${name}", which is not in package.json`],
          }
        : assessCommand(body, depth + 1);
    memo.set(name, result);
    return result;
  };

  const assessCommand = (command: string, depth: number): Assessment => {
    if (depth > MAX_SCRIPT_DEPTH)
      return { ...empty, reasons: ["scripts are nested too deeply to follow"] };
    const facts = analyzeShell(command);
    if (facts.unparsable) {
      // Fail closed: unparsable text that names a download tool could be
      // hiding curl … | sh behind a trick the parser does not understand.
      return facts.mentionsDownloader
        ? {
            ...empty,
            block: true,
            reasons: [
              "could not be parsed and mentions a download tool (failing closed)",
            ],
          }
        : {
            ...empty,
            reasons: [
              "the command could not be parsed, so croak cannot tell what it runs",
            ],
          };
    }

    const reasons: string[] = [];
    const signals = new Set<CodeSignal>();
    const knownTools = new Set(
      facts.commands.filter((name) => KNOWN_TOOLS.has(name)),
    );
    let nestedBlock = false;
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
    for (const code of facts.inlineCode)
      absorb(codeSignals(code), "inline code");

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

    for (const name of facts.runScripts) {
      for (const script of [`pre${name}`, name, `post${name}`]) {
        if (script !== name && !(script in scripts)) continue;
        const sub = assessScript(script, depth);
        nestedBlock ||= sub.block;
        for (const signal of sub.signals) signals.add(signal);
        for (const tool of sub.knownTools) knownTools.add(tool);
        if (sub.reasons.length > 0)
          reasons.push(`via script "${script}": ${sub.reasons.join("; ")}`);
      }
    }

    return {
      block: facts.downloadExecute || nestedBlock || suspicious(signals),
      reasons,
      knownTools: [...knownTools],
      signals,
    };
  };

  return (command) => assessCommand(command, 0);
}

function manifestFindings(
  repo: RepoSnapshot,
  path: string,
  { suspicious, scripts: installScripts }: LifecyclePolicy,
): Finding[] {
  const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
  const text = repo.read(path);
  if (text === undefined) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(stripBom(text));
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
  const isRoutine = routineChecker(scripts);
  const assess = assessor(repo, dir, scripts, suspicious);

  for (const name of installScripts) {
    const command = scripts[name];
    if (typeof command !== "string") continue;
    const { block, reasons, knownTools } = assess(command);
    const line = scriptLine(text, name);
    const at = line === undefined ? { file: path } : { file: path, line };
    if (!block && isRoutine(command)) {
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

/**
 * Install-time scripts in every package.json outside node_modules (workspaces
 * run theirs too). The policy decides which code-signal combinations block and
 * which scripts count; package contents use one that tolerates binary
 * installers and follows npm's rules for registry dependencies.
 */
export function lifecycleScriptWith(policy: LifecyclePolicy): RepoDetector {
  return (repo) =>
    repo.entries
      .filter(
        (e) =>
          e.kind === "file" &&
          (policy.manifests === "root"
            ? e.path === "package.json"
            : policy.manifests === "package"
              ? e.path === "package.json" || BUNDLED_MANIFEST.test(e.path)
              : posix.basename(e.path) === "package.json" &&
                !isInNodeModules(e.path)),
      )
      .flatMap((e) => manifestFindings(repo, e.path, policy));
}

export const lifecycleScript: RepoDetector = lifecycleScriptWith({
  suspicious: isSuspicious,
  scripts: INSTALL_SCRIPTS,
  manifests: "repo",
});

import { posix } from "node:path";
import {
  INSTALL_SCRIPTS,
  lifecycleScriptWith,
} from "../detectors/lifecycle-script.ts";
import {
  MAX_FILE_BYTES,
  type RepoEntry,
  type RepoSnapshot,
} from "../repo-snapshot.ts";
import { codeSignals, describeSignals, isSuspicious } from "../signals/code.ts";
import { analyzeShell } from "../signals/shell.ts";
import { stripBom } from "../signals/text.ts";
import type { Finding } from "../verdict.ts";
import { isPnpmLockfile } from "./pnpm-lockfile.ts";
import { parseYamlDocuments, YamlError } from "./yaml.ts";

const PNPM_RULE = "repo/pnpmfile";

/**
 * The project's own install scripts (whole-project review, D35). A plain
 * `npm install` and `npm ci` run the root package.json's preinstall, install,
 * postinstall and prepare (and node-gyp for a binding.gyp) — the fake
 * test-assignment attack — and the same scripts of every workspace member;
 * pnpm also runs the root's pnpm:devPreinstall (M6 review). croak judges them with the repo rules, on a small
 * snapshot: the manifest, binding.gyp, and the local files its scripts run.
 * Not all of `croak repo`: a committed node_modules would make every install
 * in an existing project a warning.
 */

export interface ProjectFs {
  /** A regular file's text, or undefined. */
  readonly read: (path: string) => string | undefined;
  /** What is at a path, without following symlinks. */
  readonly kind: (
    path: string,
  ) => { kind: "file" | "symlink" | "other"; size: number } | undefined;
}

/** pnpm also runs the root project's pnpm:devPreinstall before it installs anything. */
const PNPM_ROOT_SCRIPT = "pnpm:devPreinstall";

const policies = {
  npm: lifecycleScriptWith({
    suspicious: isSuspicious,
    scripts: INSTALL_SCRIPTS,
    manifests: "repo",
  }),
  pnpm: lifecycleScriptWith({
    suspicious: isSuspicious,
    scripts: [...INSTALL_SCRIPTS, PNPM_ROOT_SCRIPT],
    manifests: "repo",
  }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const outside = (path: string): boolean =>
  path === ".." || path.startsWith("../") || path.startsWith("/");

/**
 * The workspace members a lockfile installs, as folders relative to the
 * project (M6 review): npm's `packages` keys outside node_modules, pnpm's
 * `importers` other than the root. Both package managers run a member's
 * install scripts on a plain install, as they do the root's.
 */
export function workspaceMembers(lockfile: string): string[] {
  let keys: string[] = [];
  if (isPnpmLockfile(lockfile)) {
    const [doc] = parseYamlDocuments(lockfile);
    if (isRecord(doc) && isRecord(doc.importers))
      keys = Object.keys(doc.importers);
  } else {
    const data: unknown = JSON.parse(stripBom(lockfile));
    if (isRecord(data) && isRecord(data.packages))
      keys = Object.entries(data.packages)
        .filter(
          ([key, raw]) =>
            !key.startsWith("node_modules/") &&
            !key.includes("/node_modules/") &&
            isRecord(raw) &&
            raw.resolved === undefined,
        )
        .map(([key]) => key);
  }
  return [
    ...new Set(keys.map((k) => posix.normalize(k)).filter((k) => k !== ".")),
  ];
}

export function projectScriptFindings(
  dir: string,
  fs: ProjectFs,
  options: {
    readonly members?: readonly string[];
    readonly pnpm?: boolean;
  } = {},
): Finding[] {
  const findings: Finding[] = [];
  const entries: RepoEntry[] = [];
  const texts = new Map<string, string>();
  const add = (path: string): void => {
    const at = fs.kind(posix.join(dir, path));
    if (at === undefined || at.kind === "other") return;
    if (at.kind === "symlink") {
      entries.push({ path, kind: "symlink", size: 0 });
      return;
    }
    const oversized = at.size > MAX_FILE_BYTES;
    entries.push({
      path,
      kind: oversized ? "oversized" : "file",
      size: at.size,
    });
    const text = oversized ? undefined : fs.read(posix.join(dir, path));
    if (text !== undefined) texts.set(path, text);
  };
  for (const member of ["", ...(options.members ?? [])]) {
    if (outside(member)) {
      findings.push({
        ruleId: "repo/lifecycle-script",
        severity: "warn",
        file: "package.json",
        message: `the install also runs the install scripts of ${member}, a folder outside the project croak cannot read`,
      });
      continue;
    }
    const manifestPath = posix.join(member, "package.json");
    const manifest = fs.read(posix.join(dir, manifestPath));
    if (manifest === undefined) continue;
    let scripts: Record<string, unknown> = {};
    try {
      const data: unknown = JSON.parse(stripBom(manifest));
      if (isRecord(data) && isRecord(data.scripts)) scripts = data.scripts;
    } catch {
      // The detector reports an unreadable package.json itself.
    }
    // Every local file any script runs (install scripts call others via npm run).
    const files = new Set(["package.json", "binding.gyp"]);
    for (const command of Object.values(scripts))
      if (typeof command === "string")
        for (const file of analyzeShell(command).localFiles) {
          const path = posix.normalize(file);
          if (!outside(path)) files.add(path);
        }
    for (const file of files) add(posix.join(member, file));
  }
  const snapshot: RepoSnapshot = { entries, read: (path) => texts.get(path) };
  return [
    ...findings,
    ...policies[options.pnpm === true ? "pnpm" : "npm"](snapshot),
  ];
}

const PNPMFILES = [".pnpmfile.cjs", ".pnpmfile.mjs"];

/**
 * Code pnpm runs on every install of the project, scripts or not (M6, D39):
 * the pnpmfile (`.pnpmfile.cjs`, or the file `pnpmfile:` names in
 * pnpm-workspace.yaml) and config dependencies, which pnpm installs first and
 * whose pnpmfiles it loads. A pnpmfile is a warning, a block when its code
 * reaches the network with secrets or eval; config dependencies are a warning.
 */
export function pnpmfileFindings(dir: string, fs: ProjectFs): Finding[] {
  const findings: Finding[] = [];
  let settings: Record<string, unknown> = {};
  const workspace = fs.read(posix.join(dir, "pnpm-workspace.yaml"));
  if (workspace !== undefined) {
    try {
      const [doc] = parseYamlDocuments(workspace);
      if (isRecord(doc)) settings = doc;
    } catch (error) {
      if (!(error instanceof YamlError)) throw error;
      findings.push({
        ruleId: PNPM_RULE,
        severity: "warn",
        file: "pnpm-workspace.yaml",
        message:
          "pnpm-workspace.yaml cannot be read, so croak cannot tell what pnpm loads on install",
      });
    }
  }
  const named =
    typeof settings.pnpmfile === "string"
      ? [posix.normalize(settings.pnpmfile)]
      : [];
  for (const file of [...new Set([...PNPMFILES, ...named])]) {
    if (file === ".." || file.startsWith("../") || file.startsWith("/")) {
      findings.push({
        ruleId: PNPM_RULE,
        severity: "warn",
        file: "pnpm-workspace.yaml",
        message: `pnpm runs ${file}, a pnpmfile outside the project, on every install`,
      });
      continue;
    }
    const at = fs.kind(posix.join(dir, file));
    if (at === undefined) continue;
    const text =
      at.kind === "file" && at.size <= MAX_FILE_BYTES
        ? fs.read(posix.join(dir, file))
        : undefined;
    if (text === undefined) {
      findings.push({
        ruleId: PNPM_RULE,
        severity: "warn",
        file,
        message: `pnpm runs ${file} on every install, and croak could not read it`,
      });
      continue;
    }
    const hits = codeSignals(text);
    const signals = new Set(hits.map((h) => h.signal));
    findings.push({
      ruleId: PNPM_RULE,
      severity: isSuspicious(signals) ? "block" : "warn",
      file,
      message: `pnpm runs ${file} on every install${hits.length > 0 ? `: ${describeSignals(hits, file)}` : ""}`,
    });
  }
  if (
    isRecord(settings.configDependencies) &&
    Object.keys(settings.configDependencies).length > 0
  )
    findings.push({
      ruleId: PNPM_RULE,
      severity: "warn",
      file: "pnpm-workspace.yaml",
      message: `pnpm installs config dependencies first and loads their pnpmfiles: ${Object.keys(settings.configDependencies).slice(0, 5).join(", ")}`,
    });
  return findings;
}

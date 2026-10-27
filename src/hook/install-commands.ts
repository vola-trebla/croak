import { posix } from "node:path";
import {
  type ShellCommand,
  type ShellWord,
  shellCommands,
} from "../signals/shell.ts";

/**
 * What an agent's shell command would install or download-and-run, found
 * before it runs (M4, D32, D34). The hook checks each intent with
 * croak-install. Anything croak cannot vouch for — a package manager it does
 * not check yet, other registry settings, a path or package only known at run
 * time, a package manager reached through another command — is reported as
 * `unchecked`, never ignored: the hook denies it (D20).
 */
export type InstallIntent =
  /** npm install/add <specs>; no specs means "install what package.json lists". */
  | {
      readonly kind: "install";
      /** Which package manager installs; npm when absent. */
      readonly manager?: "npm" | "pnpm";
      readonly dir: string;
      readonly packages: readonly string[];
      readonly global: boolean;
    }
  /** npm update [specs]: newest versions in range, not the locked ones. */
  | {
      readonly kind: "update";
      readonly manager?: "npm" | "pnpm";
      readonly dir: string;
      readonly packages: readonly string[];
    }
  /** npm ci: installs the lockfile exactly as written. */
  | {
      readonly kind: "ci";
      readonly manager?: "npm" | "pnpm";
      readonly dir: string;
    }
  /** npx / npm exec / npm create: downloads a package and runs it at once. */
  | {
      readonly kind: "run";
      readonly manager?: "npm" | "pnpm";
      readonly dir: string;
      readonly packages: readonly string[];
    }
  | {
      readonly kind: "unchecked";
      readonly command: string;
      readonly reason: string;
    };

/** Agent commands can be long (heredocs); the parser is linear. */
const MAX_COMMAND_LENGTH = 100_000;
const MAX_DEPTH = 4;

/** Any of these in a command croak cannot follow makes it unchecked. */
const MENTIONS = /\b(?:npm|npx|pnpm|pnpx|yarn|bun|bunx|corepack)\b/;
const PACKAGE_MANAGERS = new Set([
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "corepack",
]);

// ------------------------------------------------------------ npm commands

/** npm's commands (npm 10/11 cmd-list), for its unique-prefix matching. */
const NPM_COMMANDS = [
  "access",
  "adduser",
  "audit",
  "bugs",
  "cache",
  "ci",
  "completion",
  "config",
  "dedupe",
  "deprecate",
  "diff",
  "dist-tag",
  "docs",
  "doctor",
  "edit",
  "exec",
  "explain",
  "explore",
  "find-dupes",
  "fund",
  "get",
  "help",
  "help-search",
  "hook",
  "init",
  "install",
  "install-ci-test",
  "install-test",
  "link",
  "ll",
  "login",
  "logout",
  "ls",
  "org",
  "outdated",
  "owner",
  "pack",
  "ping",
  "pkg",
  "prefix",
  "profile",
  "prune",
  "publish",
  "query",
  "rebuild",
  "repo",
  "restart",
  "root",
  "run-script",
  "sbom",
  "search",
  "set",
  "shrinkwrap",
  "star",
  "stars",
  "start",
  "stop",
  "team",
  "test",
  "token",
  "undeprecate",
  "uninstall",
  "unpublish",
  "unstar",
  "update",
  "version",
  "view",
  "whoami",
];
const NPM_ALIASES: Readonly<Record<string, string>> = {
  i: "install",
  in: "install",
  ins: "install",
  inst: "install",
  insta: "install",
  instal: "install",
  isnt: "install",
  isnta: "install",
  isntal: "install",
  isntall: "install",
  add: "install",
  it: "install-test",
  cit: "install-ci-test",
  "clean-install-test": "install-ci-test",
  sit: "install-ci-test",
  ic: "ci",
  "clean-install": "ci",
  "install-clean": "ci",
  "isntall-clean": "ci",
  up: "update",
  upgrade: "update",
  udpate: "update",
  x: "exec",
  create: "init",
  innit: "init",
  ddp: "dedupe",
  un: "uninstall",
  unlink: "uninstall",
  remove: "uninstall",
  rm: "uninstall",
  r: "uninstall",
  rb: "rebuild",
  list: "ls",
  la: "ls",
  ln: "link",
  run: "run-script",
  rum: "run-script",
  urn: "run-script",
  t: "test",
  tst: "test",
  c: "config",
  why: "explain",
  info: "view",
  show: "view",
  v: "view",
  s: "search",
  se: "search",
  find: "search",
};
const NPM_NAMES = [...NPM_COMMANDS, ...Object.keys(NPM_ALIASES)];
/** Subcommands that download or install packages. */
const INSTALLING = new Set([
  "install",
  "install-test",
  "ci",
  "install-ci-test",
  "update",
  "exec",
  "init",
  "dedupe",
  "link",
]);

/** npm's deref: camelCase to kebab-case, aliases, then a unique prefix. */
export function npmCommand(word: string): string | undefined {
  const name = word.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  const exact =
    NPM_ALIASES[name] ?? (NPM_COMMANDS.includes(name) ? name : undefined);
  if (exact !== undefined) return exact;
  const matches = new Set(
    NPM_NAMES.filter((n) => n.startsWith(name)).map((n) => NPM_ALIASES[n] ?? n),
  );
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** npm options that take a value (`--prefix dir`, `-C dir`, `-w pkg`). */
const VALUE_FLAGS = new Set([
  "prefix",
  "workspace",
  "registry",
  "userconfig",
  "globalconfig",
  "cache",
  "loglevel",
  "tag",
  "package",
  "call",
  "omit",
  "include",
  "before",
  "install-strategy",
  "save-prefix",
  "cpu",
  "os",
  "libc",
  "location",
  "otp",
  "scope",
  "proxy",
  "https-proxy",
  "noproxy",
  "cafile",
  "ca",
  "cert",
  "key",
  "node-options",
  "script-shell",
  "shell",
  "fetch-retries",
  "fetch-timeout",
  "maxsockets",
  "replace-registry-host",
  "auth-type",
  "access",
  "logs-dir",
  "logs-max",
  "tmp",
  "editor",
  "init-module",
  "lockfile-version",
  "depth",
  "color",
  "umask",
  "user-agent",
  "heading",
  "browser",
  "viewer",
  "message",
  "preid",
  "sbom-format",
  "sbom-type",
  "expect-results",
  "expect-result-count",
  "audit-level",
  "fetch-retry-factor",
  "fetch-retry-mintimeout",
  "fetch-retry-maxtimeout",
]);
/** npm options that are flags (no value). */
const BOOLEAN_FLAGS = new Set([
  "save",
  "save-dev",
  "save-exact",
  "save-optional",
  "save-peer",
  "save-prod",
  "save-bundle",
  "global",
  "legacy-peer-deps",
  "strict-peer-deps",
  "force",
  "dry-run",
  "ignore-scripts",
  "audit",
  "fund",
  "prefer-offline",
  "prefer-online",
  "offline",
  "foreground-scripts",
  "include-workspace-root",
  "workspaces",
  "package-lock",
  "package-lock-only",
  "yes",
  "quiet",
  "silent",
  "verbose",
  "json",
  "parseable",
  "long",
  "all",
  "production",
  "dev",
  "bin-links",
  "strict-ssl",
  "update-notifier",
  "global-style",
  "legacy-bundling",
  "rebuild-bundle",
  "engine-strict",
  "if-present",
  "ignore-existing",
  "timing",
  "usage",
  "version",
  "versions",
  "help",
  "link",
  "progress",
  "unicode",
  "install-links",
  "provenance",
  "sign-git-commit",
  "sign-git-tag",
  "git-tag-version",
  "commit-hooks",
  "shrinkwrap",
]);
/** npm's short flags that take a value; every other short flag is a boolean. */
const SHORT_VALUES: Readonly<Record<string, string>> = {
  "-C": "prefix",
  "-L": "location",
  "-w": "workspace",
  "-c": "call",
};
/** npx (not npm, where -p is --parseable) reads -p as --package. */
const NPX_SHORT_VALUES: Readonly<Record<string, string>> = {
  ...SHORT_VALUES,
  "-p": "package",
};
const SHORT_BOOLEANS: Readonly<Record<string, string>> = {
  "-g": "global",
  "-D": "save-dev",
  "-E": "save-exact",
  "-O": "save-optional",
  "-P": "save-prod",
  "-S": "save",
  "-B": "save-bundle",
  "-f": "force",
  "-y": "yes",
};

interface NpmArgs {
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly positional: readonly string[];
  /** An unknown option followed by a word: croak cannot tell a value from a package. */
  readonly ambiguous: string | undefined;
}

function readNpmArgs(words: readonly string[], npx: boolean): NpmArgs {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  const shortValues = npx ? NPX_SHORT_VALUES : SHORT_VALUES;
  const add = (key: string, value: string): void => {
    flags.set(key, [...(flags.get(key) ?? []), value]);
  };
  let ambiguous: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "--" || (npx && positional.length > 0)) {
      // npx stops reading its own options at the command it runs.
      positional.push(...words.slice(word === "--" ? i + 1 : i));
      break;
    }
    if (!word.startsWith("-") || word === "-") {
      positional.push(word);
      continue;
    }
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const key = word.slice(2, eq === -1 ? undefined : eq);
      const next = words[i + 1];
      if (eq !== -1) add(key, word.slice(eq + 1));
      else if (key.startsWith("no-") || BOOLEAN_FLAGS.has(key))
        add(key, "true");
      else if (VALUE_FLAGS.has(key) || key.endsWith("registry"))
        add(key, words[++i] ?? "");
      else {
        if (next !== undefined && !next.startsWith("-")) ambiguous ??= word;
        add(key, "true");
      }
      continue;
    }
    const value = shortValues[word];
    if (value !== undefined) add(value, words[++i] ?? "");
    else add(SHORT_BOOLEANS[word] ?? word, "true");
  }
  return { flags, positional, ambiguous };
}

/** npm init foo → create-foo; @s → @s/create; @s/foo@1 → @s/create-foo@1 (npm's rule). */
function initializer(spec: string): string {
  const at = spec.indexOf("@", 1);
  const [name, version] =
    at === -1 ? [spec, ""] : [spec.slice(0, at), spec.slice(at)];
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    return slash === -1
      ? `${name}/create${version}`
      : `${name.slice(0, slash)}/create-${name.slice(slash + 1)}${version}`;
  }
  return `create-${name}${version}`;
}

interface State {
  dir: string | undefined;
}

function npmIntents(
  name: "npm" | "npx",
  args: readonly string[],
  state: State,
  home: string,
  depth: number,
  raw: string,
): InstallIntent[] {
  const unchecked = (reason: string): InstallIntent[] => [
    { kind: "unchecked", command: raw, reason },
  ];
  const { flags, positional, ambiguous } = readNpmArgs(args, name === "npx");
  if (
    [...flags.keys()].some(
      (k) =>
        k.endsWith("registry") ||
        ["replace-registry-host", "userconfig", "globalconfig"].includes(k),
    )
  )
    return unchecked(
      "it points npm at a registry or config croak does not check",
    );
  const prefix = flags.get("prefix")?.at(-1);
  const dir =
    prefix === undefined || state.dir === undefined
      ? state.dir
      : posix.resolve(state.dir, prefix);
  const call = flags.get("call")?.at(-1);
  const where = (intents: InstallIntent[]): InstallIntent[] =>
    dir === undefined && intents.length > 0
      ? unchecked("the directory it runs in is only known when the shell runs")
      : intents;

  if (name === "npx") {
    if (call !== undefined) return intentsFor(call, { dir }, home, depth + 1);
    const packages = flags.get("package") ?? positional.slice(0, 1);
    return where(
      packages.length === 0 ? [] : [{ kind: "run", dir: dir ?? "", packages }],
    );
  }
  const [word, ...rest] = positional;
  if (word === undefined) return [];
  const sub = npmCommand(word);
  if (sub === "audit" && rest[0] === "fix")
    return unchecked("croak does not check npm audit fix yet");
  if (
    sub === undefined ||
    !INSTALLING.has(sub) ||
    ((sub === "init" || sub === "link") && rest.length === 0)
  ) {
    // An unknown option may have swallowed the real subcommand (npm --proxy x install).
    if (
      ambiguous !== undefined &&
      rest.some((w) => INSTALLING.has(npmCommand(w) ?? ""))
    )
      return unchecked(`croak cannot tell whether ${ambiguous} takes a value`);
    return [];
  }
  if (ambiguous !== undefined)
    return unchecked(`croak cannot tell whether ${ambiguous} takes a value`);
  const at = dir ?? "";
  const global =
    flags.has("global") || flags.get("location")?.at(-1) === "global";
  switch (sub) {
    case "install":
    case "install-test":
      return where([{ kind: "install", dir: at, packages: rest, global }]);
    case "ci":
    case "install-ci-test":
      return where([{ kind: "ci", dir: at }]);
    case "update":
      return global
        ? unchecked("croak does not check global updates yet")
        : where([{ kind: "update", dir: at, packages: rest }]);
    case "exec": {
      if (call !== undefined) return intentsFor(call, { dir }, home, depth + 1);
      const packages = flags.get("package") ?? rest.slice(0, 1);
      return where(
        packages.length === 0 ? [] : [{ kind: "run", dir: at, packages }],
      );
    }
    case "init":
      return where([
        { kind: "run", dir: at, packages: [initializer(rest[0] ?? "")] },
      ]);
    default:
      return unchecked(`croak does not check npm ${sub} yet`);
  }
}

// ------------------------------------------------------------ pnpm commands

const PNPM_INSTALL = new Set(["install", "i", "add", "install-test", "it"]);
const PNPM_UPDATE = new Set(["update", "up", "upgrade"]);
/** Subcommands that install, or run another pnpm, in ways croak does not plan. */
const PNPM_UNCHECKED = new Set([
  "dedupe",
  "deploy",
  "with",
  "fetch",
  "link",
  "ln",
  "import",
  "patch",
  "patch-commit",
  "patch-remove",
  "self-update",
]);
/** pnpm options that take a value. */
const PNPM_VALUE_FLAGS = new Set([
  "-C",
  "--dir",
  "--filter",
  "-F",
  "--registry",
  "--reporter",
  "--loglevel",
  "--store-dir",
  "--virtual-store-dir",
  "--package",
  "--workspace-concurrency",
  "--network-concurrency",
  "--child-concurrency",
  "--resolution-mode",
  "--node-linker",
  "--cache-dir",
]);
/** pnpm options that are flags. */
const PNPM_BOOLEAN_FLAGS = new Set([
  "-D",
  "-P",
  "-O",
  "-E",
  "-g",
  "-w",
  "-r",
  "--save-dev",
  "--save-prod",
  "--save-optional",
  "--save-exact",
  "--save-peer",
  "--global",
  "--workspace-root",
  "--recursive",
  "--workspace",
  "--frozen-lockfile",
  "--no-frozen-lockfile",
  "--prefer-offline",
  "--offline",
  "--ignore-scripts",
  "--lockfile-only",
  "--fix-lockfile",
  "--force",
  "--silent",
  "--latest",
  "-L",
  "--interactive",
  "-i",
  "--dev",
  "--prod",
  "--no-optional",
  "--strict-peer-dependencies",
  "--shamefully-hoist",
  "--aggregate-output",
  "--stream",
  "--use-stderr",
  "--yes",
  "-y",
  "--shell-mode",
  "-c",
]);

function pnpmIntents(
  args: readonly string[],
  state: State,
  raw: string,
  dlx: boolean,
): InstallIntent[] {
  const unchecked = (reason: string): InstallIntent[] => [
    { kind: "unchecked", command: raw, reason },
  ];
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  // An allowlist: pnpm has flags that allow every build, load a pnpmfile or
  // move the lockfile; a flag croak does not know is not guessed at (M6 review).
  let unknown: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? "";
    if (word === "--" || (dlx && positional.length > 0)) {
      positional.push(...args.slice(word === "--" ? i + 1 : i));
      break;
    }
    if (!word.startsWith("-") || word === "-") {
      positional.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const key = eq === -1 ? word : word.slice(0, eq);
    if (!PNPM_VALUE_FLAGS.has(key) && !PNPM_BOOLEAN_FLAGS.has(key))
      unknown ??= word;
    if (eq !== -1)
      flags.set(key, [...(flags.get(key) ?? []), word.slice(eq + 1)]);
    else if (PNPM_VALUE_FLAGS.has(key))
      flags.set(key, [...(flags.get(key) ?? []), args[++i] ?? ""]);
    else flags.set(key, ["true"]);
  }
  if (flags.has("--registry"))
    return unchecked(
      "it points pnpm at a registry or config croak does not check",
    );
  const target = flags.get("-C")?.at(-1) ?? flags.get("--dir")?.at(-1);
  const dir =
    target === undefined || state.dir === undefined
      ? state.dir
      : posix.resolve(state.dir, target);
  const where = (intents: InstallIntent[]): InstallIntent[] =>
    dir === undefined && intents.length > 0
      ? unchecked("the directory it runs in is only known when the shell runs")
      : intents;
  const global = flags.has("-g") || flags.has("--global");
  if (dlx) {
    if (unknown !== undefined)
      return unchecked(
        `croak does not know pnpm's ${unknown}, so it cannot vouch for this command`,
      );
    const packages = flags.get("--package") ?? positional.slice(0, 1);
    return where(
      packages.length === 0
        ? []
        : [{ kind: "run", manager: "pnpm", dir: dir ?? "", packages }],
    );
  }
  const [sub, ...rest] = positional;
  if (sub !== undefined && PNPM_UNCHECKED.has(sub))
    return unchecked(`croak does not check pnpm ${sub} yet`);
  const installing =
    sub === undefined ||
    PNPM_INSTALL.has(sub) ||
    PNPM_UPDATE.has(sub) ||
    sub === "dlx" ||
    sub === "create" ||
    sub === "ci" ||
    positional.some((w) => PNPM_INSTALL.has(w) || PNPM_UNCHECKED.has(w));
  if (unknown !== undefined && installing)
    return unchecked(
      `croak does not know pnpm's ${unknown}, so it cannot vouch for this install`,
    );
  if (sub === undefined) return []; // bare pnpm prints its help
  if (sub === "dlx") return pnpmIntents(rest, { dir }, raw, true);
  if (sub === "create")
    return where(
      rest[0] === undefined
        ? []
        : [
            {
              kind: "run",
              manager: "pnpm",
              dir: dir ?? "",
              packages: [initializer(rest[0])],
            },
          ],
    );
  if (PNPM_UPDATE.has(sub))
    return global
      ? unchecked("croak does not check global updates yet")
      : where([
          { kind: "update", manager: "pnpm", dir: dir ?? "", packages: rest },
        ]);
  if (
    sub === "ci" ||
    (PNPM_INSTALL.has(sub) &&
      flags.has("--frozen-lockfile") &&
      rest.length === 0)
  )
    return where([{ kind: "ci", manager: "pnpm", dir: dir ?? "" }]);
  if (!PNPM_INSTALL.has(sub)) return [];
  return where([
    {
      kind: "install",
      manager: "pnpm",
      dir: dir ?? "",
      packages: rest,
      global,
    },
  ]);
}

// ------------------------------------------------------------ shell commands

/** Wrappers and the options of theirs that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set([
    "-u",
    "-g",
    "-p",
    "-C",
    "-h",
    "-r",
    "-t",
    "-U",
    "-D",
    "-R",
    "-T",
  ]),
  doas: new Set(["-u", "-C"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  time: new Set(["-f", "-o"]),
  exec: new Set(["-a"]),
  env: new Set(["-u", "--unset"]),
  command: new Set(),
  builtin: new Set(),
  nohup: new Set(),
  setsid: new Set(),
  caffeinate: new Set(["-t", "-w"]),
};
/** Shell keywords that start or end a compound command, not a command name. */
const KEYWORDS = new Set([
  "{",
  "}",
  "!",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "for",
  "case",
  "esac",
  "in",
  "select",
  "function",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
/** Commands that take a package manager's name as plain text, not to run it. */
const TEXT_ONLY = new Set([
  "echo",
  "printf",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "git",
  "which",
  "type",
  "whereis",
  "man",
  "info",
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "ls",
  "test",
  "[",
  "printenv",
  "alias",
  "hash",
  "sed",
  "awk",
  "jq",
  "nvm",
  "fnm",
  "volta",
]);
const OTHER_MANAGERS: Readonly<Record<string, ReadonlySet<string>>> = {
  yarn: new Set(["", "install", "add", "up", "upgrade", "dlx", "create"]),
  bun: new Set(["install", "i", "add", "update", "x", "create"]),
};
const OTHER_RUNNERS = new Set(["bunx", "corepack"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const basename = (word: string): string =>
  word.slice(word.lastIndexOf("/") + 1);

/** The command's real head and arguments, past keywords, assignments and wrappers. */
function resolve(words: readonly ShellWord[]): {
  words: readonly ShellWord[];
  foreignEnv: boolean;
  problem: string | undefined;
} {
  let rest = words;
  let foreignEnv = false;
  const assignment = (word: ShellWord | undefined): boolean => {
    if (word === undefined || !ASSIGNMENT.test(word.text)) return false;
    if (/^p?npm_config_/i.test(word.text)) foreignEnv = true;
    return true;
  };
  for (;;) {
    const first = rest[0];
    if (first === undefined)
      return { words: rest, foreignEnv, problem: undefined };
    const name = basename(first.text);
    const values = WRAPPERS[name];
    if (
      KEYWORDS.has(first.text) ||
      /^[\w.:-]+\(\)$/.test(first.text) ||
      assignment(first)
    ) {
      rest = rest.slice(1);
      continue;
    }
    if (values === undefined)
      return { words: rest, foreignEnv, problem: undefined };
    rest = rest.slice(1);
    while (rest[0]?.text.startsWith("-")) {
      const flag = rest[0]?.text ?? "";
      if (flag === "--") {
        rest = rest.slice(1);
        break;
      }
      if (
        name === "env" &&
        /^-(?:[a-zA-Z]*[SC]|-split-string|-chdir)/.test(flag)
      )
        return {
          words: rest,
          foreignEnv,
          problem: "env changes how or where the command runs",
        };
      rest = rest.slice(values.has(flag) ? 2 : 1);
    }
    if (name === "timeout" && /^\d/.test(rest[0]?.text ?? ""))
      rest = rest.slice(1);
    if (name === "env") while (assignment(rest[0])) rest = rest.slice(1);
  }
}

/** The script a shell runs with -c (also -lc, -ec, -e -c). */
function shellScript(args: readonly ShellWord[]): ShellWord | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]?.text ?? "";
    if (!arg.startsWith("-")) return undefined;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) return args[i + 1];
  }
  return undefined;
}

function intentsOf(
  commands: readonly ShellCommand[],
  state: State,
  home: string,
  depth: number,
  text: string,
): InstallIntent[] {
  const found: InstallIntent[] = [];
  for (const command of commands) {
    if (command.group !== undefined) {
      // A subshell's cd does not leak out; a { …; } group's does. Either way,
      // after a cd inside one, the outer directory is no longer certain.
      const inner = { dir: state.dir };
      found.push(...intentsOf(command.group, inner, home, depth, text));
      if (inner.dir !== state.dir) state.dir = undefined;
      if (command.words.length === 0) continue;
    }
    const raw = command.words.map((w) => w.text).join(" ");
    const unchecked = (reason: string): void => {
      found.push({ kind: "unchecked", command: raw, reason });
    };
    const { words, foreignEnv, problem } = resolve(command.words);
    const [head, ...argWords] = words;
    if (head === undefined) continue;
    if (problem !== undefined) {
      if (MENTIONS.test(raw)) unchecked(problem);
      continue;
    }
    if (head.dynamic) {
      // n=npm; $n install x — the command is only known when the shell runs.
      if (MENTIONS.test(text))
        unchecked("the command it runs is only known when the shell runs");
      continue;
    }
    const name = basename(head.text);
    const args = argWords.map((w) => w.text);

    if (name === "cd" || name === "pushd") {
      const target = argWords[0];
      state.dir =
        target === undefined
          ? home
          : target.dynamic || state.dir === undefined || target.text === "-"
            ? undefined
            : posix.resolve(state.dir, target.text.replace(/^~(?=\/|$)/, home));
      continue;
    }
    if (SHELLS.has(name)) {
      const script = shellScript(argWords);
      if (script === undefined) {
        // A script from stdin (a pipe) that mentions a package manager: croak
        // does not see it. A script file is like `npm run x`: a documented gap.
        const fromStdin = !argWords.some((w) => !w.text.startsWith("-"));
        if (fromStdin && MENTIONS.test(text))
          unchecked(`${name} runs a script from stdin croak cannot see`);
      } else if (script.dynamic) {
        if (MENTIONS.test(script.text))
          unchecked("the script it runs is only known when the shell runs");
      } else found.push(...intentsFor(script.text, state, home, depth + 1));
      continue;
    }
    if (name === "eval" || name === "source" || name === ".") {
      if (MENTIONS.test(raw)) unchecked(`${name} hides what it runs`);
      continue;
    }
    if (name === "npm" || name === "npx") {
      if (foreignEnv) {
        unchecked("npm settings are changed through the environment");
        continue;
      }
      const intents = npmIntents(name, args, state, home, depth, raw);
      if (
        intents.some((i) => i.kind !== "unchecked") &&
        words.some((w) => w.dynamic)
      )
        unchecked("a package or path in it is only known when the shell runs");
      else found.push(...intents);
      continue;
    }
    if (name === "pnpm" || name === "pnpx") {
      if (foreignEnv) {
        unchecked("pnpm settings are changed through the environment");
        continue;
      }
      const intents = pnpmIntents(args, state, raw, name === "pnpx");
      if (
        intents.some((i) => i.kind !== "unchecked") &&
        words.some((w) => w.dynamic)
      )
        unchecked("a package or path in it is only known when the shell runs");
      else found.push(...intents);
      continue;
    }
    const other = OTHER_MANAGERS[name];
    if (
      OTHER_RUNNERS.has(name) ||
      other?.has(args.find((a) => !a.startsWith("-")) ?? "") === true
    ) {
      unchecked(`croak checks npm only; ${name} support is planned (M6)`);
      continue;
    }
    // xargs npm i, find -exec npm i, watch npm i, docker run … npm i: a
    // package manager run by another command, with arguments croak cannot follow.
    if (
      !TEXT_ONLY.has(name) &&
      argWords.some((w) => PACKAGE_MANAGERS.has(basename(w.text)))
    )
      unchecked(`it runs a package manager through ${name}`);
  }
  return found;
}

/** Heredoc bodies are data for most commands, and a script croak cannot see for a shell. */
function stripHeredocs(command: string): {
  text: string;
  shellHeredoc: boolean;
} {
  const lines = command.split("\n");
  const out: string[] = [];
  let shellHeredoc = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    out.push(line);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (m === null) continue;
    const body: string[] = [];
    while (++i < lines.length) {
      const next = lines[i] ?? "";
      if ((m[1] === "-" ? next.trim() : next) === m[3]) break;
      body.push(next);
    }
    if (
      /\b(?:sh|bash|zsh|dash|ksh)\b[^<]*<</.test(line) &&
      MENTIONS.test(body.join("\n"))
    )
      shellHeredoc = true;
  }
  return { text: out.join("\n"), shellHeredoc };
}

/** Settings in the same command that move npm to another registry. */
const CONFIG_CHANGE =
  /\b(?:npm|pnpm)\s+(?:config\s+)?(?:set|edit)\b|\bexport\s+(?:npm|pnpm)_config_|>>?\s*\S*(?:\.npmrc|pnpm-workspace\.yaml)\b/i;

function intentsFor(
  command: string,
  state: State,
  home: string,
  depth: number,
): InstallIntent[] {
  const { text, shellHeredoc } = stripHeredocs(command);
  const commands =
    depth > MAX_DEPTH ? undefined : shellCommands(text, MAX_COMMAND_LENGTH);
  if (commands === undefined)
    return MENTIONS.test(command)
      ? [
          {
            kind: "unchecked",
            command: command.slice(0, 200),
            reason: "croak could not parse the command",
          },
        ]
      : [];
  const found = intentsOf(commands, state, home, depth, text);
  if (shellHeredoc)
    found.push({
      kind: "unchecked",
      command: command.slice(0, 200),
      reason: "a shell runs a heredoc croak does not check",
    });
  if (found.some((i) => i.kind !== "unchecked") && CONFIG_CHANGE.test(text))
    return [
      {
        kind: "unchecked",
        command: command.slice(0, 200),
        reason: "it changes npm's registry settings before installing",
      },
    ];
  return found;
}

/** Install intents in `command`, run from `cwd` (absolute) by a user whose home is `home`. */
export function installIntents(
  command: string,
  cwd: string,
  home: string,
): InstallIntent[] {
  return intentsFor(command, { dir: cwd }, home, 0);
}

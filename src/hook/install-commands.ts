import { posix } from "node:path";
import {
  type ShellCommand,
  type ShellWord,
  shellCommands,
} from "../signals/shell.ts";

/**
 * What an agent's shell command would install or download-and-run, found
 * before it runs (M4, D32). The hook checks each intent with croak-install.
 * Anything croak cannot vouch for — a package manager it does not check yet,
 * a custom registry, a path or package only known at run time — is reported
 * as `unchecked`, never ignored: the hook fails closed on it (D20).
 */
export type InstallIntent =
  /** npm install/add <specs>; no specs means "install what package.json lists". */
  | {
      readonly kind: "install";
      readonly dir: string;
      readonly packages: readonly string[];
      readonly global: boolean;
    }
  /** npm ci: installs the lockfile exactly as written. */
  | { readonly kind: "ci"; readonly dir: string }
  /** npx / npm exec / npm create: downloads a package and runs it at once. */
  | {
      readonly kind: "run";
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

const INSTALL = new Set([
  "install",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "install-test",
  "it",
  "update",
  "up",
  "upgrade",
  "udpate",
]);
const CI = new Set([
  "ci",
  "clean-install",
  "ic",
  "install-clean",
  "isntall-clean",
  "install-ci-test",
  "cit",
]);
const EXEC = new Set(["exec", "x"]);
const CREATE = new Set(["create", "init", "innit"]);
/** npm flags that take a value (`--prefix dir`, `-w pkg`). */
const VALUE_FLAGS = new Set([
  "--prefix",
  "--workspace",
  "-w",
  "--registry",
  "--userconfig",
  "--globalconfig",
  "--cache",
  "--loglevel",
  "--tag",
  "--package",
  "-p",
  "--call",
  "-c",
  "--omit",
  "--include",
  "--before",
  "--install-strategy",
  "--save-prefix",
  "--cpu",
  "--os",
  "--libc",
  "--location",
  "--otp",
  "--scope",
]);
/** Flags that make npm talk to something croak does not check. */
const FOREIGN_CONFIG = new Set([
  "--registry",
  "--userconfig",
  "--globalconfig",
]);
const WRAPPERS = new Set([
  "sudo",
  "env",
  "time",
  "nice",
  "nohup",
  "command",
  "exec",
  "timeout",
  "caffeinate",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const OTHER_MANAGERS: Readonly<Record<string, ReadonlySet<string>>> = {
  pnpm: new Set(["install", "i", "add", "update", "up", "dlx", "create"]),
  yarn: new Set(["", "install", "add", "up", "upgrade", "dlx", "create"]),
  bun: new Set(["install", "i", "add", "update", "x", "create"]),
};
const OTHER_RUNNERS = new Set(["pnpx", "bunx"]);
/** Any of these in a command croak cannot parse makes it unchecked. */
const MENTIONS = /\b(?:npm|npx|pnpm|pnpx|yarn|bun|bunx)\b/;

interface State {
  dir: string | undefined;
}

const basename = (word: string): string =>
  word.slice(word.lastIndexOf("/") + 1);

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

/** Splits npm arguments into flags and positionals; values of value-taking flags are consumed. */
function readArgs(words: readonly string[]): {
  flags: Map<string, string[]>;
  positional: string[];
} {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  const add = (flag: string, value: string): void => {
    flags.set(flag, [...(flags.get(flag) ?? []), value]);
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "--") {
      positional.push(...words.slice(i + 1));
      break;
    }
    if (!word.startsWith("-") || word === "-") {
      positional.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    if (eq !== -1) add(word.slice(0, eq), word.slice(eq + 1));
    else if (VALUE_FLAGS.has(word)) add(word, words[++i] ?? "");
    else add(word, "true");
  }
  return { flags, positional };
}

/** npm and npx commands, after wrappers and environment assignments are stripped. */
function npmIntents(
  name: string,
  args: readonly string[],
  state: State,
  raw: string,
): InstallIntent[] {
  const unchecked = (reason: string): InstallIntent[] => [
    { kind: "unchecked", command: raw, reason },
  ];
  const { flags, positional } = readArgs(args);
  if ([...FOREIGN_CONFIG].some((f) => flags.has(f)))
    return unchecked(
      "it points npm at a registry or config croak does not check",
    );
  const prefix = flags.get("--prefix")?.at(-1);
  const dir =
    prefix === undefined || state.dir === undefined
      ? state.dir
      : posix.resolve(state.dir, prefix);
  if (dir === undefined)
    return unchecked(
      "the directory it runs in is only known when the shell runs",
    );

  if (name === "npx") {
    const packages =
      flags.get("--package") ?? flags.get("-p") ?? positional.slice(0, 1);
    return packages.length === 0 ? [] : [{ kind: "run", dir, packages }];
  }
  const [sub, ...rest] = positional;
  if (sub === undefined) return [];
  if (INSTALL.has(sub))
    return [
      {
        kind: "install",
        dir,
        packages: rest,
        global: flags.has("-g") || flags.has("--global"),
      },
    ];
  if (CI.has(sub)) return [{ kind: "ci", dir }];
  if (EXEC.has(sub)) {
    const packages =
      flags.get("--package") ?? flags.get("-p") ?? rest.slice(0, 1);
    return packages.length === 0 ? [] : [{ kind: "run", dir, packages }];
  }
  if (CREATE.has(sub)) {
    const [spec] = rest;
    return spec === undefined
      ? []
      : [{ kind: "run", dir, packages: [initializer(spec)] }];
  }
  return [];
}

function intentsOf(
  commands: readonly ShellCommand[],
  state: State,
  home: string,
  depth: number,
): InstallIntent[] {
  const found: InstallIntent[] = [];
  for (const command of commands) {
    if (command.group !== undefined) {
      // A subshell's cd does not leak out; a { …; } group's does. Either way,
      // after a cd inside one, the outer directory is no longer certain.
      const inner = { dir: state.dir };
      found.push(...intentsOf(command.group, inner, home, depth));
      if (inner.dir !== state.dir) state.dir = undefined;
      continue;
    }
    const raw = command.words.map((w) => w.text).join(" ");
    let words: readonly ShellWord[] = command.words;
    let foreignEnv = false;
    // Strip environment assignments and wrappers (sudo, env, time, …).
    for (;;) {
      const first = words[0];
      if (first === undefined) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text)) {
        if (/^npm_config_/i.test(first.text)) foreignEnv = true;
        words = words.slice(1);
      } else if (WRAPPERS.has(basename(first.text))) {
        words = words.slice(1);
        while (words[0]?.text.startsWith("-")) words = words.slice(1);
      } else break;
    }
    const [head, ...argWords] = words;
    if (head === undefined) continue;
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
    if (SHELLS.has(name) && args[0] === "-c" && args[1] !== undefined) {
      if (argWords[1]?.dynamic === true && MENTIONS.test(args[1])) {
        found.push({
          kind: "unchecked",
          command: raw,
          reason: "the script it runs is only known when the shell runs",
        });
        continue;
      }
      found.push(...intentsFor(args[1], state, home, depth + 1));
      continue;
    }
    if (name === "eval" && MENTIONS.test(args.join(" "))) {
      found.push({
        kind: "unchecked",
        command: raw,
        reason: "eval hides what it runs",
      });
      continue;
    }
    if (name === "npm" || name === "npx") {
      if (foreignEnv) {
        found.push({
          kind: "unchecked",
          command: raw,
          reason: "npm settings are changed through the environment",
        });
        continue;
      }
      const intents = npmIntents(name, args, state, raw);
      if (intents.length > 0 && words.some((w) => w.dynamic))
        found.push({
          kind: "unchecked",
          command: raw,
          reason: "a package or path in it is only known when the shell runs",
        });
      else found.push(...intents);
      continue;
    }
    const other = OTHER_MANAGERS[name];
    if (
      OTHER_RUNNERS.has(name) ||
      other?.has(args.find((a) => !a.startsWith("-")) ?? "") === true
    ) {
      found.push({
        kind: "unchecked",
        command: raw,
        reason: `croak checks npm only; ${name} support is planned (M6)`,
      });
    }
  }
  return found;
}

function intentsFor(
  command: string,
  state: State,
  home: string,
  depth: number,
): InstallIntent[] {
  const commands =
    depth > 4 ? undefined : shellCommands(command, MAX_COMMAND_LENGTH);
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
  return intentsOf(commands, state, home, depth);
}

/** Install intents in `command`, run from `cwd` (absolute) by a user whose home is `home`. */
export function installIntents(
  command: string,
  cwd: string,
  home: string,
): InstallIntent[] {
  return intentsFor(command, { dir: cwd }, home, 0);
}

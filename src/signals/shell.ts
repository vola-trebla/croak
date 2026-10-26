/**
 * A small, defensive shell parser for package.json scripts. It understands
 * quoting, pipes, command lists, `$(...)`, backticks, `<(...)`, subshells,
 * redirects, and `sh -c '...'` — enough to see what a script really runs,
 * without one fragile regex. It never executes anything.
 *
 * Linear scanning only; input length and nesting depth are capped so hostile
 * scripts cannot make it hang.
 */

export interface ShellFacts {
  /** Downloads something and executes it (pipe, substitution, or file). */
  readonly downloadExecute: boolean;
  /** Uses a network download tool anywhere. */
  readonly network: boolean;
  /** Relative paths of local files the script executes, in order. */
  readonly localFiles: readonly string[];
  /** Code passed inline to node -e / --eval / -p. */
  readonly inlineCode: readonly string[];
  /** Command names in order, with wrappers (sudo, env, npx, …) stripped. */
  readonly commands: readonly string[];
  /** package.json scripts run via `npm run X`, `pnpm X`, `yarn X`, `npm test`, … */
  readonly runScripts: readonly string[];
  /**
   * Things that change what a command does beyond its name: environment
   * assignments (NODE_OPTIONS=…, PATH=…), redirects, command wrappers (sudo,
   * env, npx with flags), workspace-wide package-manager flags (-r, --filter).
   */
  readonly modifiers: readonly string[];
  /** Quotes or nesting could not be parsed; nothing else is reliable. */
  readonly unparsable: boolean;
  /** A download tool's name appears anywhere in the raw text (fail-closed input). */
  readonly mentionsDownloader: boolean;
}

export const MAX_SCRIPT_LENGTH = 10_000;
const MAX_DEPTH = 8;

const DOWNLOADERS = new Set([
  "curl",
  "wget",
  "aria2c",
  "http",
  "https",
  "xh",
  "fetch",
  "iwr",
  "irm",
  "invoke-webrequest",
  "invoke-restmethod",
  "certutil",
  "bitsadmin",
]);

/** Commands that execute code they are given via stdin, arguments, or files. */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "fish",
  "node",
  "nodejs",
  "deno",
  "bun",
  "tsx",
  "ts-node",
  "python",
  "python2",
  "python3",
  "perl",
  "ruby",
  "php",
  "pwsh",
  "powershell",
  "iex",
  "invoke-expression",
  "eval",
  "source",
  ".",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
const NODE_LIKE = new Set(["node", "nodejs", "tsx", "ts-node"]);
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "nice",
  "env",
  "busybox",
  "npx",
  "pnpx",
  "bunx",
  "timeout",
  "xargs",
  "stdbuf",
  "setsid",
  "ionice",
]);
/** Shell keywords that start or end a compound command, not a command name. */
const RESERVED = new Set([
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
]);
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Package-manager subcommands that are not package.json script names. */
const PM_BUILTINS = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "exec",
  "dlx",
  "x",
  "create",
  "init",
  "link",
  "unlink",
  "publish",
  "pack",
  "audit",
  "outdated",
  "list",
  "ls",
  "why",
  "rebuild",
  "prune",
  "dedupe",
  "config",
  "set",
  "help",
]);
/** npm runs these scripts without `run`. */
const NPM_SCRIPT_ALIASES = new Set(["test", "start", "stop", "restart"]);

/** The package.json script a package-manager command runs, if any. */
function scriptName(name: string, args: readonly Word[]): string | undefined {
  if (!PACKAGE_RUNNERS.has(name) && name !== "bun") return undefined;
  const positional = args.map((a) => a.text).filter((t) => !t.startsWith("-"));
  const [first, second] = positional;
  if (first === "run" || first === "run-script") return second;
  if (first === undefined) return undefined;
  if (name === "npm") return NPM_SCRIPT_ALIASES.has(first) ? first : undefined;
  return PM_BUILTINS.has(first) ? undefined : first;
}

// ---------------------------------------------------------------- parsing

interface Word {
  /** Text with quotes removed; substitutions appear as a placeholder. */
  readonly text: string;
  /** Scripts inside $(...), `...`, <(...), >(...). */
  readonly subs: readonly Script[];
}

interface Command {
  readonly words: readonly Word[];
  readonly redirects: readonly { readonly op: string; readonly target: Word }[];
  /** Body of a ( ... ) subshell, if this command is one. */
  readonly subshell?: Script;
}

type Pipeline = readonly Command[];
type Script = readonly Pipeline[];

class ParseError extends Error {}

/** Index just past the `close` that balances the opener before `start`. */
function findClose(
  input: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 1;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new ParseError("unbalanced '");
      i = end;
    } else if (ch === '"') {
      i = findDoubleQuoteEnd(input, i + 1);
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new ParseError(`unbalanced ${open}`);
}

function findDoubleQuoteEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    if (input[i] === "\\") i++;
    else if (input[i] === '"') return i;
  }
  throw new ParseError('unbalanced "');
}

function findBacktickEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    if (input[i] === "\\") i++;
    else if (input[i] === "`") return i;
  }
  throw new ParseError("unbalanced `");
}

function parse(input: string, depth: number): Script {
  if (depth > MAX_DEPTH) throw new ParseError("nested too deeply");
  const script: Pipeline[] = [];
  let pipeline: Command[] = [];
  let words: Word[] = [];
  let redirects: { op: string; target: Word }[] = [];
  let subshell: Script | undefined;
  let text = "";
  let subs: Script[] = [];
  let inWord = false;
  let pendingRedirect: string | undefined;

  const endWord = (): void => {
    if (!inWord) return;
    const word = { text, subs };
    if (pendingRedirect !== undefined) {
      redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = undefined;
    } else {
      words.push(word);
    }
    text = "";
    subs = [];
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0 || subshell !== undefined || redirects.length > 0) {
      pipeline.push(
        subshell === undefined
          ? { words, redirects }
          : { words, redirects, subshell },
      );
    }
    words = [];
    redirects = [];
    subshell = undefined;
  };
  const endPipeline = (): void => {
    endCommand();
    if (pipeline.length > 0) script.push(pipeline);
    pipeline = [];
  };
  const substitution = (body: string): void => {
    subs.push(parse(body, depth + 1));
    text += "$(…)";
    inWord = true;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? "";
    const next = input[i + 1];
    if (ch === "\\") {
      text += input[i + 1] ?? "";
      inWord = true;
      i++;
    } else if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new ParseError("unbalanced '");
      text += input.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      const end = findDoubleQuoteEnd(input, i + 1);
      // Inside double quotes, $(...) and backticks still run.
      const body = input.slice(i + 1, end);
      for (let j = 0; j < body.length; j++) {
        if (body[j] === "\\") {
          text += body[j + 1] ?? "";
          j++;
        } else if (body[j] === "$" && body[j + 1] === "(") {
          const close = findClose(body, j + 2, "(", ")");
          substitution(body.slice(j + 2, close - 1));
          j = close - 1;
        } else if (body[j] === "`") {
          const close = findBacktickEnd(body, j + 1);
          substitution(body.slice(j + 1, close));
          j = close;
        } else {
          text += body[j];
        }
      }
      inWord = true;
      i = end;
    } else if (ch === "$" && next === "(") {
      const close = findClose(input, i + 2, "(", ")");
      substitution(input.slice(i + 2, close - 1));
      i = close - 1;
    } else if ((ch === "<" || ch === ">") && next === "(") {
      const close = findClose(input, i + 2, "(", ")");
      substitution(input.slice(i + 2, close - 1));
      i = close - 1;
    } else if (ch === "`") {
      const close = findBacktickEnd(input, i + 1);
      substitution(input.slice(i + 1, close));
      i = close;
    } else if (ch === "#" && !inWord) {
      // A comment runs to the end of the line, quotes and all.
      const newline = input.indexOf("\n", i);
      i = (newline === -1 ? input.length : newline) - 1;
    } else if (
      ch === "{" &&
      !inWord &&
      words.length === 0 &&
      (next === " " || next === "\t" || next === "\n")
    ) {
      // { …; } groups commands like a subshell does.
      const close = findClose(input, i + 1, "{", "}");
      subshell = parse(input.slice(i + 1, close - 1), depth + 1);
      i = close - 1;
    } else if (ch === "(" && !inWord && words.length === 0) {
      const close = findClose(input, i + 1, "(", ")");
      subshell = parse(input.slice(i + 1, close - 1), depth + 1);
      i = close - 1;
    } else if (ch === "|" && next === "|") {
      endPipeline();
      i++;
    } else if (ch === "|") {
      endCommand();
      if (next === "&") i++;
    } else if (ch === "&" && next === "&") {
      endPipeline();
      i++;
    } else if (ch === ";" || ch === "&" || ch === "\n") {
      endPipeline();
    } else if (ch === ">" || ch === "<") {
      // A leading fd number (2>) belongs to the redirect, not to a word.
      if (inWord && /^\d+$/.test(text) && subs.length === 0) {
        text = "";
        inWord = false;
      }
      endWord();
      let op = ch;
      if (next === ch || next === "&") {
        op += next;
        i++;
      }
      pendingRedirect = op;
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else {
      text += ch;
      inWord = true;
    }
  }
  endPipeline();
  return script;
}

// ---------------------------------------------------------------- analysis

const basename = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);
const normalizeName = (word: string): string =>
  basename(word)
    .toLowerCase()
    .replace(/\.exe$/, "");
const stripDot = (path: string): string =>
  path.startsWith("./") ? path.slice(2) : path;
const urlFileName = (url: string): string =>
  basename(url.split(/[?#]/)[0] ?? "");

/** The real command after env assignments and wrappers, with its arguments. */
const NPX_LIKE = new Set(["npx", "pnpx", "bunx"]);
const WORKSPACE_FLAGS = new Set([
  "-r",
  "--recursive",
  "--filter",
  "-F",
  "-w",
  "--workspace",
  "--workspaces",
  "-ws",
  "--if-present",
]);

interface Resolved {
  readonly name: string;
  readonly raw: string;
  readonly args: readonly Word[];
  readonly modifiers: readonly string[];
}

/** The real command after env assignments and wrappers, with its arguments. */
function resolveCommand(command: Command): Resolved | undefined {
  const words = [...command.words];
  const modifiers: string[] = [];
  while (words.length > 0) {
    const first = words[0];
    if (first === undefined) break;
    if (RESERVED.has(first.text)) {
      words.shift();
      continue;
    }
    if (ASSIGNMENT.test(first.text)) {
      modifiers.push(`sets ${first.text.slice(0, first.text.indexOf("="))}`);
      words.shift();
      continue;
    }
    const name = normalizeName(first.text);
    if (WRAPPERS.has(name)) {
      words.shift();
      const flags: string[] = [];
      // Skip wrapper flags (sudo -u user, nice -n 5, npx --yes).
      while (words[0]?.text.startsWith("-")) {
        const flag = words.shift()?.text ?? "";
        flags.push(flag);
        if (
          ["-u", "-n", "-g", "-p", "-I", "-s", "--package"].includes(flag) &&
          words.length > 1
        ) {
          words.shift();
        }
      }
      // timeout's first operand is the duration, not the command.
      if (name === "timeout" && /^\d/.test(words[0]?.text ?? "")) words.shift();
      // A bare npx runs a local bin; npx with flags or any other wrapper changes what runs.
      if (!NPX_LIKE.has(name) || flags.length > 0)
        modifiers.push(
          `runs through ${name}${flags.length > 0 ? ` ${flags.join(" ")}` : ""}`,
        );
      continue;
    }
    if (
      PACKAGE_RUNNERS.has(name) &&
      (words[1]?.text === "exec" || words[1]?.text === "dlx")
    ) {
      modifiers.push(`runs through ${name} ${words[1]?.text}`);
      words.splice(0, 2);
      continue;
    }
    const args = words.slice(1);
    if (
      (PACKAGE_RUNNERS.has(name) || name === "bun") &&
      args.some((a) => WORKSPACE_FLAGS.has(a.text.split("=")[0] ?? ""))
    ) {
      modifiers.push("runs scripts across workspaces");
    }
    return { name, raw: first.text, args, modifiers };
  }
  return undefined;
}

interface Acc {
  downloadExecute: boolean;
  network: boolean;
  localFiles: string[];
  inlineCode: string[];
  commands: string[];
  runScripts: string[];
  modifiers: string[];
  downloaded: Set<string>;
}

const hasNetwork = (script: Script): boolean => {
  const acc = newAcc();
  walkScript(script, acc, 0);
  return acc.network;
};

function newAcc(): Acc {
  return {
    downloadExecute: false,
    network: false,
    localFiles: [],
    inlineCode: [],
    commands: [],
    runScripts: [],
    modifiers: [],
    downloaded: new Set(),
  };
}

function addLocal(acc: Acc, path: string): void {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.startsWith("-") ||
    path.includes("$(…)")
  )
    return;
  const clean = stripDot(path);
  if (!acc.localFiles.includes(clean)) acc.localFiles.push(clean);
}

/** Files a downloader writes, so a later command that runs them is caught. */
function downloadTargets(
  name: string,
  args: readonly Word[],
  redirects: Command["redirects"],
): string[] {
  const targets: string[] = [];
  const url = args.find((a) => /^[a-z]+:\/\//i.test(a.text))?.text ?? "";
  let wgetOutput = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]?.text ?? "";
    const value = args[i + 1]?.text;
    if (name === "curl") {
      // -o FILE, also inside a cluster such as -sSLo FILE
      if (
        (flag === "--output" || /^-[a-zA-Z]*o$/.test(flag)) &&
        value !== undefined
      )
        targets.push(value);
      if (flag === "--remote-name" || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(flag))
        targets.push(urlFileName(url));
    }
    if (name === "wget") {
      // -O FILE, -qO FILE, -qO- (stdout), --output-document=FILE
      const cluster = /^-[a-zA-Z]*O(.*)$/.exec(flag);
      const long = flag.startsWith("--output-document")
        ? (flag.split("=")[1] ?? value)
        : undefined;
      if (cluster !== null || long !== undefined) {
        wgetOutput = true;
        const attached = cluster?.[1];
        const target =
          long ??
          (attached !== undefined && attached !== "" ? attached : value);
        if (target !== undefined && target !== "-") targets.push(target);
      }
    }
  }
  if (name === "wget" && !wgetOutput) targets.push(urlFileName(url));
  for (const { op, target } of redirects)
    if (op === ">" || op === ">>") targets.push(target.text);
  return targets.filter((t) => t !== "").map(stripDot);
}

function walkCommand(
  command: Command,
  acc: Acc,
  depth: number,
): { readonly downloader: boolean; readonly interpreter: boolean } {
  if (command.subshell !== undefined) {
    const inner = newAcc();
    walkScript(command.subshell, inner, depth + 1);
    merge(acc, inner);
    return { downloader: inner.network, interpreter: false };
  }
  for (const word of command.words)
    for (const sub of word.subs) walkScript(sub, acc, depth + 1);
  for (const { target } of command.redirects)
    for (const sub of target.subs) walkScript(sub, acc, depth + 1);

  const resolved = resolveCommand(command);
  if (resolved === undefined) return { downloader: false, interpreter: false };
  const { name, raw, args } = resolved;
  acc.commands.push(name);
  acc.modifiers.push(...resolved.modifiers);
  if (command.redirects.length > 0)
    acc.modifiers.push("redirects input or output");
  const script = scriptName(name, args);
  if (script !== undefined) acc.runScripts.push(script);

  // Running a file the script downloaded earlier.
  if (
    acc.downloaded.has(stripDot(raw)) ||
    args.some(
      (a) => INTERPRETERS.has(name) && acc.downloaded.has(stripDot(a.text)),
    )
  ) {
    acc.downloadExecute = true;
  }

  const downloader = DOWNLOADERS.has(name);
  if (downloader) {
    acc.network = true;
    for (const target of downloadTargets(name, args, command.redirects))
      acc.downloaded.add(target);
  }

  const interpreter = INTERPRETERS.has(name);
  if (interpreter) {
    // bash <(curl …), sh -c "$(curl …)", eval "$(curl …)"
    const fed = [...args, ...command.redirects.map((r) => r.target)].some((w) =>
      w.subs.some(hasNetwork),
    );
    if (fed) acc.downloadExecute = true;
  }

  if (raw.includes("/") && !interpreter && !downloader) addLocal(acc, raw);

  if (SHELLS.has(name)) {
    // -c, also inside a cluster such as -ec or -xc
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text));
    const body = c === -1 ? undefined : args[c + 1];
    if (body !== undefined) {
      walkScript(parse(body.text, depth + 1), acc, depth + 1);
    } else {
      const file = args.find((a) => !a.text.startsWith("-"));
      if (file !== undefined) addLocal(acc, file.text);
    }
  } else if (
    NODE_LIKE.has(name) ||
    name === "python" ||
    name === "python3" ||
    name === "perl" ||
    name === "ruby"
  ) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]?.text ?? "";
      const value = args[i + 1]?.text;
      const eq = arg.indexOf("=");
      const [flag, inline] =
        eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
      if (
        flag === "-e" ||
        flag === "--eval" ||
        flag === "-p" ||
        flag === "--print" ||
        flag === "-c"
      ) {
        const code = inline ?? value;
        if (code !== undefined) acc.inlineCode.push(code);
        if (inline === undefined) i++;
        if (NODE_LIKE.has(name)) continue;
        break;
      }
      if (flag === "-r" || flag === "--require" || flag === "--import") {
        const file = inline ?? value;
        if (file !== undefined) addLocal(acc, file);
        if (inline === undefined) i++;
        continue;
      }
      if (arg.startsWith("-")) continue;
      addLocal(acc, arg);
      break;
    }
  }
  return { downloader, interpreter };
}

/** A command with a process substitution whose first command is an interpreter, as in `tee >(sh)`. */
function feedsInterpreter(command: Command): boolean {
  return command.words.some((word) =>
    word.subs.some((sub) => {
      const first = sub[0]?.[0];
      const resolved = first === undefined ? undefined : resolveCommand(first);
      return resolved !== undefined && INTERPRETERS.has(resolved.name);
    }),
  );
}

function walkScript(script: Script, acc: Acc, depth: number): void {
  for (const pipeline of script) {
    let downloaded = false;
    for (const command of pipeline) {
      const { downloader, interpreter } = walkCommand(command, acc, depth);
      // curl … | sh, curl … | tee f | sh, curl … | tee >(sh)
      if ((interpreter || feedsInterpreter(command)) && downloaded)
        acc.downloadExecute = true;
      if (downloader) downloaded = true;
    }
  }
}

function merge(into: Acc, from: Acc): void {
  into.downloadExecute ||= from.downloadExecute;
  into.network ||= from.network;
  for (const f of from.localFiles)
    if (!into.localFiles.includes(f)) into.localFiles.push(f);
  into.inlineCode.push(...from.inlineCode);
  into.commands.push(...from.commands);
  into.runScripts.push(...from.runScripts);
  into.modifiers.push(...from.modifiers);
  for (const d of from.downloaded) into.downloaded.add(d);
}

function mentionsDownloader(command: string): boolean {
  return command
    .split(/[^A-Za-z0-9._/-]+/)
    .some((token) => DOWNLOADERS.has(normalizeName(token)));
}

export function analyzeShell(command: string): ShellFacts {
  const unparsable: ShellFacts = {
    downloadExecute: false,
    network: false,
    localFiles: [],
    inlineCode: [],
    commands: [],
    runScripts: [],
    modifiers: [],
    unparsable: true,
    mentionsDownloader: mentionsDownloader(command),
  };
  if (command.length > MAX_SCRIPT_LENGTH) return unparsable;
  let script: Script;
  try {
    script = parse(command, 0);
  } catch (error) {
    if (error instanceof ParseError) return unparsable;
    throw error;
  }
  const acc = newAcc();
  try {
    walkScript(script, acc, 0);
  } catch (error) {
    if (error instanceof ParseError) return unparsable;
    throw error;
  }
  return {
    downloadExecute: acc.downloadExecute,
    network: acc.network,
    localFiles: acc.localFiles,
    inlineCode: acc.inlineCode,
    commands: acc.commands,
    runScripts: acc.runScripts,
    modifiers: [...new Set(acc.modifiers)],
    mentionsDownloader: mentionsDownloader(command),
    unparsable: false,
  };
}

// ---------------------------------------------------------------- command sequence

export interface ShellWord {
  readonly text: string;
  /** Contains $VAR, $(…) or backticks: its value is only known when the shell runs. */
  readonly dynamic: boolean;
}

export interface ShellCommand {
  readonly words: readonly ShellWord[];
  /** The commands of a ( … ) subshell or { …; } group, if this is one. */
  readonly group?: readonly ShellCommand[];
}

/**
 * Commands in the order the shell would run them (pipelines and lists
 * flattened), for callers that need argument-level detail, such as the agent
 * hook. Undefined when the text cannot be parsed or is longer than maxLength.
 */
export function shellCommands(
  input: string,
  maxLength = MAX_SCRIPT_LENGTH,
): ShellCommand[] | undefined {
  if (input.length > maxLength) return undefined;
  let script: Script;
  try {
    script = parse(input, 0);
  } catch (error) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
  const flatten = (s: Script): ShellCommand[] =>
    s.flatMap((pipeline) =>
      pipeline.map((command) => {
        const words = command.words.map((w) => ({
          text: w.text,
          dynamic: w.subs.length > 0 || w.text.includes("$"),
        }));
        return command.subshell === undefined
          ? { words }
          : { words, group: flatten(command.subshell) };
      }),
    );
  return flatten(script);
}

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
  /** Quotes or nesting could not be parsed; nothing else is reliable. */
  readonly unparsable: boolean;
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
]);
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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
function resolveCommand(command: Command):
  | {
      readonly name: string;
      readonly raw: string;
      readonly args: readonly Word[];
    }
  | undefined {
  const words = [...command.words];
  while (words.length > 0) {
    const first = words[0];
    if (first === undefined) break;
    if (ASSIGNMENT.test(first.text)) {
      words.shift();
      continue;
    }
    const name = normalizeName(first.text);
    if (WRAPPERS.has(name)) {
      words.shift();
      // Skip wrapper flags (sudo -u user, nice -n 5, npx --yes).
      while (words[0]?.text.startsWith("-")) {
        const flag = words.shift()?.text;
        if (
          (flag === "-u" || flag === "-n" || flag === "-g") &&
          words.length > 1
        )
          words.shift();
      }
      continue;
    }
    if (
      PACKAGE_RUNNERS.has(name) &&
      (words[1]?.text === "exec" || words[1]?.text === "dlx")
    ) {
      words.splice(0, 2);
      continue;
    }
    return { name, raw: first.text, args: words.slice(1) };
  }
  return undefined;
}

interface Acc {
  downloadExecute: boolean;
  network: boolean;
  localFiles: string[];
  inlineCode: string[];
  commands: string[];
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
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]?.text;
    const value = args[i + 1]?.text;
    if (
      name === "curl" &&
      (flag === "-o" || flag === "--output") &&
      value !== undefined
    )
      targets.push(value);
    if (name === "curl" && (flag === "-O" || flag === "--remote-name"))
      targets.push(urlFileName(url));
    if (
      name === "wget" &&
      (flag === "-O" || flag === "--output-document") &&
      value !== undefined &&
      value !== "-"
    ) {
      targets.push(value);
    }
  }
  if (
    name === "wget" &&
    !args.some(
      (a) =>
        a.text === "-O" ||
        a.text.startsWith("-qO") ||
        a.text === "--output-document",
    )
  ) {
    targets.push(urlFileName(url));
  }
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
    const c = args.findIndex((a) => a.text === "-c");
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

function walkScript(script: Script, acc: Acc, depth: number): void {
  for (const pipeline of script) {
    let downloaded = false;
    for (const command of pipeline) {
      const { downloader, interpreter } = walkCommand(command, acc, depth);
      // curl … | sh, curl … | tee f | sh
      if (interpreter && downloaded) acc.downloadExecute = true;
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
  for (const d of from.downloaded) into.downloaded.add(d);
}

export function analyzeShell(command: string): ShellFacts {
  const unparsable: ShellFacts = {
    downloadExecute: false,
    network: false,
    localFiles: [],
    inlineCode: [],
    commands: [],
    unparsable: true,
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
    unparsable: false,
  };
}

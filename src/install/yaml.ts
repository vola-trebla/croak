/**
 * A strict reader for the YAML that pnpm writes in pnpm-lock.yaml (M6, D38):
 * block mappings by indentation, plain and quoted scalars, flow mappings
 * `{a: b}` and flow sequences `[a, b]`, several documents split by `---`.
 * The lockfile comes from an untrusted repo, so anything outside that subset
 * (anchors, tags, block sequences, multi-line scalars) is a YamlError — the
 * check is then incomplete, never guessed at. Linear scanning; size, depth
 * and key counts are capped.
 */

export class YamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlError";
  }
}

export interface YamlLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxKeys: number;
}

export const DEFAULT_YAML_LIMITS: YamlLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 32,
  maxKeys: 2_000_000,
};

type Value = string | Value[] | { [key: string]: Value };

/** A scalar: 'single', "double" (simple escapes only) or plain. */
function scalar(raw: string, where: string): string {
  const text = raw.trim();
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2)
      throw new YamlError(`${where}: unterminated quote`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2)
      throw new YamlError(`${where}: unterminated quote`);
    const body = text.slice(1, -1);
    if (/\\[^"\\/nt]/.test(body))
      throw new YamlError(`${where}: unsupported escape`);
    return body
      .replace(/\\(["\\/])/g, "$1")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }
  if (/^[&*!|>%@`]/.test(text))
    throw new YamlError(`${where}: unsupported YAML (${text.slice(0, 1)})`);
  return text;
}

/** Splits a flow collection's body at top-level commas, respecting quotes and nesting. */
function splitFlow(body: string, where: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) throw new YamlError(`${where}: unbalanced brackets`);
  }
  if (quote !== undefined || depth !== 0)
    throw new YamlError(`${where}: unbalanced brackets or quotes`);
  const last = body.slice(start);
  if (last.trim() !== "" || parts.length > 0) parts.push(last);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** The index of the `: ` (or a final `:`) that ends a key, outside quotes and brackets. */
function keyEnd(text: string): number {
  let quote: string | undefined;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (
      depth === 0 &&
      ch === ":" &&
      (i === text.length - 1 || text[i + 1] === " ")
    )
      return i;
  }
  return -1;
}

function flowValue(
  raw: string,
  where: string,
  depth: number,
  limits: YamlLimits,
): Value {
  if (depth > limits.maxDepth)
    throw new YamlError(`${where}: nested too deeply`);
  const text = raw.trim();
  if (text.startsWith("{")) {
    if (!text.endsWith("}"))
      throw new YamlError(`${where}: unterminated flow mapping`);
    const out: { [key: string]: Value } = {};
    for (const part of splitFlow(text.slice(1, -1), where)) {
      const at = keyEnd(part);
      if (at === -1)
        throw new YamlError(`${where}: flow mapping entry without a key`);
      out[scalar(part.slice(0, at), where)] = flowValue(
        part.slice(at + 1),
        where,
        depth + 1,
        limits,
      );
    }
    return out;
  }
  if (text.startsWith("[")) {
    if (!text.endsWith("]"))
      throw new YamlError(`${where}: unterminated flow sequence`);
    return splitFlow(text.slice(1, -1), where).map((part) =>
      flowValue(part, where, depth + 1, limits),
    );
  }
  return scalar(text, where);
}

function parseDocument(
  lines: readonly { n: number; text: string }[],
  limits: YamlLimits,
): Value {
  const root: { [key: string]: Value } = {};
  // Open mappings by indentation: the deepest last.
  const stack: { indent: number; map: { [key: string]: Value } }[] = [
    { indent: -1, map: root },
  ];
  let keys = 0;
  let sequence: { indent: number; items: Value[] } | undefined;
  let pending:
    | { key: string; parent: { [key: string]: Value }; indent: number }
    | undefined;
  for (const { n, text } of lines) {
    const where = `line ${n}`;
    if (text.includes("\t")) throw new YamlError(`${where}: tab character`);
    const indent = text.length - text.trimStart().length;
    const body = text.trim();
    // A block sequence of scalars under a key (pnpm writes
    // transitivePeerDependencies this way); nothing nested.
    if (body.startsWith("- ") || body === "-") {
      if (pending !== undefined && indent >= pending.indent) {
        sequence = { indent, items: [] };
        pending.parent[pending.key] = sequence.items;
        pending = undefined;
      }
      if (sequence === undefined || indent !== sequence.indent)
        throw new YamlError(`${where}: unsupported block sequence`);
      const item = body.slice(1).trim();
      if (item === "" || keyEnd(item) !== -1)
        throw new YamlError(`${where}: only scalar list items are supported`);
      sequence.items.push(flowValue(item, where, stack.length, limits));
      continue;
    }
    sequence = undefined;
    // A flow collection on the line after its key (as Biome and Prettier
    // write it) is that key's value; anywhere else it is not YAML pnpm writes.
    if (body.startsWith("{") || body.startsWith("[")) {
      if (pending === undefined || indent <= pending.indent)
        throw new YamlError(`${where}: a flow collection without a key`);
      pending.parent[pending.key] = flowValue(
        body,
        where,
        stack.length,
        limits,
      );
      pending = undefined;
      continue;
    }
    let opened = false;
    if (pending !== undefined) {
      // The previous key opened a nested mapping (or is empty if this line is not deeper).
      if (indent > pending.indent) {
        const child: { [key: string]: Value } = {};
        pending.parent[pending.key] = child;
        stack.push({ indent, map: child });
        opened = true;
      } else pending.parent[pending.key] = {};
      pending = undefined;
    }
    while (
      !opened &&
      stack.length > 1 &&
      indent < (stack[stack.length - 1]?.indent ?? -1)
    )
      stack.pop();
    const top = stack[stack.length - 1];
    if (top === undefined) throw new YamlError(`${where}: bad indentation`);
    if (indent !== (stack.length === 1 ? 0 : top.indent))
      throw new YamlError(`${where}: inconsistent indentation`);
    if (stack.length > limits.maxDepth)
      throw new YamlError(`${where}: nested too deeply`);
    const at = keyEnd(body);
    if (at === -1) throw new YamlError(`${where}: expected "key: value"`);
    const key = scalar(body.slice(0, at), where);
    if (Object.hasOwn(top.map, key))
      throw new YamlError(`${where}: duplicate key ${JSON.stringify(key)}`);
    keys += 1;
    if (keys > limits.maxKeys)
      throw new YamlError(`more than ${limits.maxKeys} keys`);
    const rest = body.slice(at + 1).trim();
    if (rest === "") pending = { key, parent: top.map, indent };
    else top.map[key] = flowValue(rest, where, stack.length, limits);
  }
  if (pending !== undefined) pending.parent[pending.key] = {};
  return root;
}

/**
 * A line without its comment: a `#` outside quotes that starts the line or
 * follows whitespace (YAML's rule; `repo#commit` keeps its `#`).
 */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (
      ch === "#" &&
      (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")
    )
      return line.slice(0, i).trimEnd();
  }
  return line;
}

/** How many flow brackets a line leaves open, outside quotes. */
function openBrackets(line: string, start: number): number {
  let depth = start;
  let quote: string | undefined;
  for (const ch of line) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return depth;
}

/** Every document in the text (split at `---` lines), as plain objects. */
export function parseYamlDocuments(
  text: string,
  limits: Partial<YamlLimits> = {},
): unknown[] {
  const all = { ...DEFAULT_YAML_LIMITS, ...limits };
  if (text.length > all.maxBytes)
    throw new YamlError(`larger than ${all.maxBytes} bytes`);
  const docs: { n: number; text: string }[][] = [[]];
  // A flow collection a formatter spread over several lines (Biome, Prettier)
  // is joined back into one logical line, as YAML reads it.
  let open: { n: number; text: string; depth: number } | undefined;
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const line = stripComment(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (open !== undefined) {
      open.text += ` ${line.trim()}`;
      open.depth = openBrackets(line, open.depth);
      if (open.depth <= 0) {
        docs[docs.length - 1]?.push({ n: open.n, text: open.text });
        open = undefined;
      }
      return;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    if (line === "---") {
      docs.push([]);
      return;
    }
    if (line === "...") return;
    const depth = openBrackets(line, 0);
    if (depth > 0) open = { n: index + 1, text: line, depth };
    else docs[docs.length - 1]?.push({ n: index + 1, text: line });
  });
  if (open !== undefined)
    throw new YamlError(`line ${open.n}: unterminated flow collection`);
  return docs.filter((d) => d.length > 0).map((d) => parseDocument(d, all));
}

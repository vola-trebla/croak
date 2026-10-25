/**
 * JSON with comments and trailing commas, as VS Code reads `.vscode/*.json`.
 * One linear pass turns JSONC into plain JSON (comments become spaces,
 * trailing commas are dropped), then JSON.parse does the rest. Nesting depth
 * is checked during the pass so hostile input cannot recurse deeply.
 */

export const MAX_JSONC_DEPTH = 64;

export class JsoncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsoncError";
  }
}

/** Index of the next character that is not whitespace, or text.length. */
function nextSignificant(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  return i;
}

function toJson(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    const next = text[i + 1];
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"')
        end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) throw new JsoncError("unterminated string");
      out += text.slice(i, end + 1);
      i = end;
    } else if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end - 1;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new JsoncError("unterminated block comment");
      i = end + 1;
      out += " ";
    } else if (ch === "{" || ch === "[") {
      depth++;
      if (depth > MAX_JSONC_DEPTH)
        throw new JsoncError(`nested deeper than ${MAX_JSONC_DEPTH}`);
      out += ch;
    } else if (ch === "}" || ch === "]") {
      depth--;
      out += ch;
    } else if (ch === ",") {
      // Drop a comma whose next significant token (comments already being
      // skipped) closes the container.
      out += ",";
      const rest = toJsonPeek(text, i + 1);
      if (rest === "}" || rest === "]") out = out.slice(0, -1);
    } else {
      out += ch;
    }
  }
  return out;
}

/** The next significant character after `from`, skipping whitespace and comments. */
function toJsonPeek(text: string, from: number): string | undefined {
  let i = nextSignificant(text, from);
  while (
    i < text.length &&
    text[i] === "/" &&
    (text[i + 1] === "/" || text[i + 1] === "*")
  ) {
    if (text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return undefined;
      i = end + 2;
    }
    i = nextSignificant(text, i);
  }
  return text[i];
}

export function parseJsonc(text: string): unknown {
  const json = toJson(text);
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new JsoncError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

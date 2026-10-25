/**
 * A minimal git-config reader for .git/config and .gitmodules: sections,
 * `[name "subsection"]` and legacy `[name.sub]` headers, quoted values,
 * comments. Enough to see which settings make git run a command. Linear,
 * line by line; continuation lines are not supported.
 */

export interface GitConfigEntry {
  /** Lowercased name, plus the subsection as written: `filter.lfs`, `remote.origin`. */
  readonly section: string;
  /** Lowercased. */
  readonly key: string;
  readonly value: string;
  /** 1-based. */
  readonly line: number;
}

const HEADER = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/;
const KEY = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/;

/** Removes a trailing comment outside quotes, then quotes and escapes. */
function parseValue(raw: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? "";
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1] ?? "";
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && (ch === "#" || ch === ";")) {
      break;
    } else {
      out += ch;
    }
  }
  return out.trim();
}

export function parseGitConfig(text: string): GitConfigEntry[] {
  const entries: GitConfigEntry[] = [];
  let section = "";
  text.split("\n").forEach((raw, index) => {
    let line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) return;
    const header = HEADER.exec(line);
    if (header !== null) {
      const name = (header[1] ?? "").toLowerCase();
      section = header[2] === undefined ? name : `${name}.${header[2]}`;
      line = (header[3] ?? "").trim();
      if (line === "") return;
    }
    const kv = KEY.exec(line);
    if (kv === null || section === "") return;
    entries.push({
      section,
      key: (kv[1] ?? "").toLowerCase(),
      value: kv[2] === undefined ? "true" : parseValue(kv[2]),
      line: index + 1,
    });
  });
  return entries;
}

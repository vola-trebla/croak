/**
 * Facts that code was deliberately made unreadable — not merely minified.
 * Minifiers shorten names and drop whitespace but keep strings and property
 * names readable; obfuscators encode strings, rename to `_0x…`, rotate string
 * arrays, and reach `eval` through computed names. No verdicts here.
 * Patterns are linear (checked by `pnpm redos`).
 */

export type ObfuscationKind =
  | "escapes"
  | "obfuscator-names"
  | "string-array"
  | "dynamic-call"
  | "encoded-blob";

export interface ObfuscationHit {
  readonly kind: ObfuscationKind;
  /** 1-based; the first line where the signal met its threshold. */
  readonly line: number;
  /** Every line where it did (a decoy on line 1 must not hide line 51). */
  readonly lines: readonly number[];
  readonly count: number;
}

interface Pattern {
  readonly kind: ObfuscationKind;
  readonly label: string;
  readonly pattern: RegExp;
  /** Matches needed on one line (or in the file, for file-level kinds). */
  readonly threshold: number;
  readonly scope: "line" | "file";
}

export const OBFUSCATION_PATTERNS: readonly Pattern[] = [
  {
    kind: "escapes",
    label: "hex/unicode escapes",
    pattern: /\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]{1,6}\}/,
    threshold: 8,
    scope: "line",
  },
  {
    kind: "obfuscator-names",
    label: "_0x names",
    pattern: /\b_0x[0-9a-f]{3,8}\b/,
    threshold: 3,
    scope: "file",
  },
  {
    kind: "string-array",
    label: "string-array rotation",
    pattern:
      /\[\s*["']push["']\s*\]\s*\(\s*[\w$]+\s*\[\s*["']shift["']\s*\]\s*\(\s*\)\s*\)/,
    threshold: 1,
    scope: "line",
  },
  {
    kind: "dynamic-call",
    label: "computed global call",
    // globalThis[expr](…) with a non-literal key (one level of nested [] allowed),
    // but not a well-known symbol: self[Symbol.asyncIterator]() is how
    // iterators are called (the Anthropic SDK's streaming code)…
    pattern:
      /\b(?:globalThis|window|global|self)\s*\[\s*(?!Symbol\s*\.)[^\]"'`\s][^\]]{0,100}\]{1,2}\s*\(/,
    threshold: 1,
    scope: "line",
  },
  {
    kind: "dynamic-call",
    label: "string-keyed eval",
    // …or a literal key that names eval or Function.
    pattern:
      /\b(?:globalThis|window|global|self)\s*\[\s*["'`](?:eval|Function)["'`]\s*\]/,
    threshold: 1,
    scope: "line",
  },
  {
    kind: "encoded-blob",
    label: "long base64 literal",
    pattern: /["'`][A-Za-z0-9+/]{200,}={0,2}["'`]/,
    threshold: 1,
    scope: "line",
  },
];

const count = (pattern: RegExp, text: string): number =>
  [...text.matchAll(new RegExp(pattern.source, "g"))].length;

export function obfuscationSignals(text: string): ObfuscationHit[] {
  const lines = text.split("\n");
  const byKind = new Map<ObfuscationKind, { lines: number[]; count: number }>();
  const note = (kind: ObfuscationKind, line: number, n: number): void => {
    const entry = byKind.get(kind) ?? { lines: [], count: 0 };
    if (!entry.lines.includes(line)) entry.lines.push(line);
    entry.count += n;
    byKind.set(kind, entry);
  };

  lines.forEach((line, index) => {
    for (const { kind, pattern, threshold, scope } of OBFUSCATION_PATTERNS) {
      if (scope !== "line" || !pattern.test(line)) continue;
      const n = count(pattern, line);
      if (n >= threshold) note(kind, index + 1, n);
    }
  });

  for (const { kind, pattern, threshold, scope } of OBFUSCATION_PATTERNS) {
    if (scope !== "file") continue;
    const n = count(pattern, text);
    if (n < threshold) continue;
    lines.forEach((line, index) => {
      if (pattern.test(line)) note(kind, index + 1, 0);
    });
    const entry = byKind.get(kind);
    if (entry !== undefined) entry.count = n;
  }

  return [...byKind]
    .map(([kind, { lines: at, count: n }]) => ({
      kind,
      line: Math.min(...at),
      lines: at.sort((a, b) => a - b),
      count: n,
    }))
    .sort((a, b) => a.line - b.line);
}

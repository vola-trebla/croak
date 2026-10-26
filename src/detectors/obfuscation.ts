import { CODE_PATTERNS } from "../signals/code.ts";
import {
  OBFUSCATION_PATTERNS,
  type ObfuscationHit,
  type ObfuscationKind,
  obfuscationSignals,
} from "../signals/obfuscation.ts";
import type { Finding, Severity } from "../verdict.ts";
import type { RepoDetector } from "./index.ts";
import { isInNodeModules } from "./node-modules-present.ts";

const RULE = "repo/obfuscation";
const LEAD: Readonly<Record<Severity, string>> = {
  info: "unusual encoding, common in generated or vendored code",
  warn: "looks obfuscated",
  block: "obfuscated code",
};
const SCANNED = /\.[cm]?[jt]sx?$/;
/** Type declarations are never executed (eslint and playwright types name `globalThis[key](…)`). */
const DECLARATIONS = /\.d\.[cm]?ts$/;

/** Legitimate code has these too: icon-font escape maps, embedded fonts or wasm. */
const WEAK: ReadonlySet<ObfuscationKind> = new Set(["escapes", "encoded-blob"]);
/** Whole-file obfuscator output: there, eval or decoding anywhere counts. */
const FILE_WIDE: ReadonlySet<ObfuscationKind> = new Set(["obfuscator-names"]);

/** Lines within which a signal and a call count as one construct… */
const NEARBY_LINES = 3;
/** …on ordinary lines. A minified file is one giant line, so there "nearby" is measured in characters. */
const LONG_LINE = 1000;
const NEARBY_CHARS = 200;

const patternsOf = (...signals: string[]): RegExp[] =>
  CODE_PATTERNS.filter((p) => signals.includes(p.signal)).map((p) => p.pattern);
/** What runs code. Decoding alone only makes data (a parser's Unicode tables, wasm). */
const EXECUTES = patternsOf("eval");
const EXECUTES_OR_DECODES = patternsOf("eval", "decode");

interface Span {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/** Every match of `patterns` as an absolute character span, with its line. */
function spans(
  lines: readonly string[],
  patterns: readonly RegExp[],
  onLines?: ReadonlySet<number>,
): Span[] {
  const found: Span[] = [];
  let offset = 0;
  lines.forEach((text, index) => {
    const line = index + 1;
    if (onLines === undefined || onLines.has(line)) {
      for (const pattern of patterns) {
        for (const m of text.matchAll(new RegExp(pattern.source, "g"))) {
          const start = offset + (m.index ?? 0);
          found.push({ line, start, end: start + m[0].length });
        }
      }
    }
    offset += text.length + 1;
  });
  return found;
}

const gap = (a: Span, b: Span): number =>
  Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));

/**
 * A signal is next to a call when enough of its matches (its per-line
 * threshold, e.g. 8 escapes) sit within NEARBY_CHARS of the call, or, on
 * ordinary short lines, within NEARBY_LINES of it.
 */
function nearCall(
  lines: readonly string[],
  hit: ObfuscationHit,
  calls: readonly Span[],
): boolean {
  const patterns = OBFUSCATION_PATTERNS.filter((p) => p.kind === hit.kind);
  const threshold = Math.min(...patterns.map((p) => p.threshold));
  const short = (line: number): boolean =>
    (lines[line - 1]?.length ?? 0) <= LONG_LINE;
  const marks = spans(
    lines,
    patterns.map((p) => p.pattern),
    new Set(hit.lines),
  );
  return calls.some((call) => {
    if (
      short(call.line) &&
      hit.lines.some(
        (at) => short(at) && Math.abs(at - call.line) <= NEARBY_LINES,
      )
    )
      return true;
    return (
      marks.filter((m) => gap(m, call) <= NEARBY_CHARS).length >= threshold
    );
  });
}

/**
 * Weak signals alone are context; one strong signal warns. It blocks when
 * two kinds meet in one construct, when obfuscator output has eval or decoding anywhere, when
 * a local strong signal (a computed global call, a rotated string array) sits
 * next to eval or decoding, or when a weak signal sits next to eval — a
 * Unicode regex beside String.fromCharCode in a parser is not one construct.
 */
function assess(
  lines: readonly string[],
  hits: readonly ObfuscationHit[],
): { raw: Severity; why: string } {
  const kinds = new Set(hits.map((hit) => hit.kind));
  const strong = [...kinds].filter((kind) => !WEAK.has(kind)).length;
  // Two kinds are one construct when obfuscator output covers the file, or
  // when a strong signal sits next to the other kind (not 10,000 lines away
  // in a browser bundle, as in mocha.js).
  const markedBy = (hit: ObfuscationHit): Span[] =>
    spans(
      lines,
      OBFUSCATION_PATTERNS.filter((p) => p.kind === hit.kind).map(
        (p) => p.pattern,
      ),
      new Set(hit.lines),
    );
  const together =
    hits.some((hit) => FILE_WIDE.has(hit.kind)) ||
    hits.some(
      (hit) =>
        !WEAK.has(hit.kind) &&
        hits.some(
          (other) =>
            other.kind !== hit.kind && nearCall(lines, hit, markedBy(other)),
        ),
    );
  if (strong >= 1 && kinds.size >= 2 && together)
    return { raw: "block", why: "" };
  const executes = spans(lines, EXECUTES);
  const decodes = spans(lines, EXECUTES_OR_DECODES);
  const near = hits.some((hit) =>
    FILE_WIDE.has(hit.kind)
      ? decodes.length > 0
      : nearCall(lines, hit, WEAK.has(hit.kind) ? executes : decodes),
  );
  if (near) return { raw: "block", why: ", next to eval or decoding" };
  return { raw: strong >= 1 ? "warn" : "info", why: "" };
}

function fileFinding(path: string, text: string): Finding | undefined {
  const hits = obfuscationSignals(text);
  const first = hits[0];
  if (first === undefined) return undefined;
  const { raw, why } = assess(text.split("\n"), hits);
  // As with other content detectors: installed and committed dependencies look
  // the same, and repo/node-modules-present already flags the directory.
  const severity: Severity =
    isInNodeModules(path) && raw === "block" ? "warn" : raw;
  const seen = hits.map((hit) => `${hit.kind} (line ${hit.line})`).join(", ");
  return {
    ruleId: RULE,
    severity,
    file: path,
    line: first.line,
    message: `${LEAD[severity]}: ${seen}${raw === "block" ? why : ""}`,
  };
}

/** Code made deliberately unreadable — not merely minified. */
export const obfuscation: RepoDetector = (repo) =>
  repo.entries
    .filter(
      (e) =>
        e.kind === "file" && SCANNED.test(e.path) && !DECLARATIONS.test(e.path),
    )
    .flatMap((e) => {
      const finding = fileFinding(e.path, repo.read(e.path) ?? "");
      return finding === undefined ? [] : [finding];
    });

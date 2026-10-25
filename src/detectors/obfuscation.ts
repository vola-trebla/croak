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

/** Legitimate code has these too: icon-font escape maps, embedded fonts or wasm. */
const WEAK: ReadonlySet<ObfuscationKind> = new Set(["escapes", "encoded-blob"]);

/** Lines within which a weak signal and eval/decoding count as one construct… */
const NEARBY_LINES = 3;
/** …on ordinary lines. A minified file is one giant line, so there "nearby" is measured in characters. */
const LONG_LINE = 1000;
const NEARBY_CHARS = 200;

const EVAL_OR_DECODE = CODE_PATTERNS.filter(
  (p) => p.signal === "eval" || p.signal === "decode",
).map((p) => p.pattern);

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
 * A weak signal is next to eval/decoding when enough of its matches (its
 * per-line threshold, e.g. 8 escapes) sit within NEARBY_CHARS of one eval or
 * decode call, or, on ordinary short lines, within NEARBY_LINES of it.
 */
function weakNearDecode(
  lines: readonly string[],
  hit: ObfuscationHit,
  decodes: readonly Span[],
): boolean {
  const patterns = OBFUSCATION_PATTERNS.filter((p) => p.kind === hit.kind);
  const threshold = Math.min(...patterns.map((p) => p.threshold));
  const short = (line: number): boolean =>
    (lines[line - 1]?.length ?? 0) <= LONG_LINE;
  const weak = spans(
    lines,
    patterns.map((p) => p.pattern),
    new Set(hit.lines),
  );
  return decodes.some((d) => {
    if (
      short(d.line) &&
      hit.lines.some((at) => short(at) && Math.abs(at - d.line) <= NEARBY_LINES)
    )
      return true;
    return weak.filter((w) => gap(w, d) <= NEARBY_CHARS).length >= threshold;
  });
}

/**
 * Weak signals alone are context. One strong signal warns. A strong signal
 * with any second signal or with eval/decoding anywhere in the file blocks.
 * A weak signal blocks only with eval/decoding nearby — a Unicode regex and an
 * unrelated atob() 2,000 lines apart are not one construct.
 */
function severityOf(
  kinds: ReadonlySet<ObfuscationKind>,
  decodeAnywhere: boolean,
  decodeNearWeak: boolean,
): Severity {
  const strong = [...kinds].filter((kind) => !WEAK.has(kind)).length;
  if (strong >= 1 && (kinds.size >= 2 || decodeAnywhere)) return "block";
  if (decodeNearWeak) return "block";
  return strong >= 1 ? "warn" : "info";
}

function fileFinding(path: string, text: string): Finding | undefined {
  const hits = obfuscationSignals(text);
  const first = hits[0];
  if (first === undefined) return undefined;
  const kinds = new Set(hits.map((hit) => hit.kind));
  const lines = text.split("\n");
  const decodes = spans(lines, EVAL_OR_DECODE);
  const decodeNearWeak = hits.some(
    (hit) => WEAK.has(hit.kind) && weakNearDecode(lines, hit, decodes),
  );
  const raw = severityOf(kinds, decodes.length > 0, decodeNearWeak);
  // As with other content detectors: installed and committed dependencies look
  // the same, and repo/node-modules-present already flags the directory.
  const severity: Severity =
    isInNodeModules(path) && raw === "block" ? "warn" : raw;
  const seen = hits.map((hit) => `${hit.kind} (line ${hit.line})`).join(", ");
  const why =
    raw === "block" && decodes.length > 0 ? ", next to eval or decoding" : "";
  return {
    ruleId: RULE,
    severity,
    file: path,
    line: first.line,
    message: `${LEAD[severity]}: ${seen}${why}`,
  };
}

/** Code made deliberately unreadable — not merely minified. */
export const obfuscation: RepoDetector = (repo) =>
  repo.entries
    .filter((e) => e.kind === "file" && SCANNED.test(e.path))
    .flatMap((e) => {
      const finding = fileFinding(e.path, repo.read(e.path) ?? "");
      return finding === undefined ? [] : [finding];
    });

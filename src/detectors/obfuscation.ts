import { codeSignals } from "../signals/code.ts";
import {
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

/** Lines within which a weak signal and eval/decoding count as one construct. */
const NEARBY_LINES = 3;

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
  const decodeLines = codeSignals(text)
    .filter((s) => s.signal === "eval" || s.signal === "decode")
    .map((s) => s.line);
  const decodeNearWeak = hits.some(
    (hit) =>
      WEAK.has(hit.kind) &&
      hit.lines.some((at) =>
        decodeLines.some((line) => Math.abs(line - at) <= NEARBY_LINES),
      ),
  );
  const raw = severityOf(kinds, decodeLines.length > 0, decodeNearWeak);
  // As with other content detectors: installed and committed dependencies look
  // the same, and repo/node-modules-present already flags the directory.
  const severity: Severity =
    isInNodeModules(path) && raw === "block" ? "warn" : raw;
  const seen = hits.map((hit) => `${hit.kind} (line ${hit.line})`).join(", ");
  const why =
    raw === "block" && decodeLines.length > 0
      ? ", next to eval or decoding"
      : "";
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

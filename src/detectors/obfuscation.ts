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

/**
 * Weak signals alone are context. One strong signal warns. A strong signal
 * with any second signal, or any signal next to eval or decoding, blocks.
 */
function severityOf(
  kinds: ReadonlySet<ObfuscationKind>,
  evalOrDecode: boolean,
): Severity {
  const strong = [...kinds].filter((kind) => !WEAK.has(kind)).length;
  if (evalOrDecode || (strong >= 1 && kinds.size >= 2)) return "block";
  return strong >= 1 ? "warn" : "info";
}

function fileFinding(path: string, text: string): Finding | undefined {
  const hits = obfuscationSignals(text);
  const first = hits[0];
  if (first === undefined) return undefined;
  const kinds = new Set(hits.map((hit) => hit.kind));
  const evalOrDecode = codeSignals(text).some(
    (s) => s.signal === "eval" || s.signal === "decode",
  );
  const raw = severityOf(kinds, evalOrDecode);
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
    message: `${LEAD[severity]}: ${seen}${evalOrDecode ? ", next to eval or decoding" : ""}`,
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

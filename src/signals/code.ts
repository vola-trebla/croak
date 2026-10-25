// croak-invariants: pattern-data
// Detector patterns and test inputs below are data, not code (D16).
/**
 * Signals in JavaScript/TypeScript source that, in combination, indicate an
 * attack. A single signal is context, not evidence: install scripts fetch
 * binaries, build tools spawn processes. Patterns are deliberately narrow and
 * linear (checked by `pnpm redos`): they run on attacker-controlled text.
 */

export type CodeSignal = "network" | "process" | "eval" | "decode" | "secrets";

export interface SignalHit {
  readonly signal: CodeSignal;
  readonly label: string;
  /** 1-based. */
  readonly line: number;
}

const LOAD = String.raw`(?:require\s*\(\s*|from\s+|import\s*\(\s*)["']`;
const load = (modules: string): RegExp =>
  new RegExp(`${LOAD}(?:node:)?(?:${modules})["']`);

export const CODE_PATTERNS: ReadonlyArray<{
  readonly signal: CodeSignal;
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  { signal: "network", label: "fetch", pattern: /\bfetch\s*\(/ },
  {
    signal: "network",
    label: "network module",
    pattern: load("https?|http2|net|tls|dgram|dns"),
  },
  {
    signal: "network",
    label: "http client",
    pattern: load("axios|got|node-fetch|undici|request|superagent|ws"),
  },
  {
    signal: "network",
    label: "XMLHttpRequest/WebSocket",
    pattern: /\b(?:XMLHttpRequest|WebSocket)\b/,
  },
  { signal: "process", label: "child_process", pattern: load("child_process") },
  {
    signal: "process",
    label: "process library",
    pattern: load("execa|shelljs|cross-spawn"),
  },
  { signal: "eval", label: "eval", pattern: /\beval\s*\)?\s*\(/ },
  {
    signal: "eval",
    label: "Function constructor",
    pattern: /\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/,
  },
  { signal: "eval", label: "vm", pattern: load("vm") },
  { signal: "decode", label: "atob", pattern: /\batob\s*\(/ },
  {
    signal: "decode",
    label: "base64 Buffer",
    pattern: /\bBuffer\s*\.\s*from\s*\([^)]{0,500}["']base64["']/,
  },
  {
    signal: "decode",
    label: "fromCharCode",
    pattern: /\bString\s*\.\s*fromCharCode\s*\(/,
  },
  {
    signal: "secrets",
    label: "credential path",
    pattern: /[/"'`~]\.(?:ssh|npmrc|aws|gnupg|kube|docker)\b/,
  },
  {
    signal: "secrets",
    label: "private key",
    pattern: /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/,
  },
  // The whole environment, not process.env.PORT or process.env[name].
  {
    signal: "secrets",
    label: "process.env",
    pattern: /\bprocess\s*\.\s*env\b(?!\s*(?:\.|\[|\?\.))/,
  },
  { signal: "secrets", label: "home directory", pattern: /\bhomedir\s*\(/ },
  {
    signal: "secrets",
    label: "shell profile",
    pattern: /[/"'`~]\.(?:zshrc|bashrc|bash_profile|zprofile|profile)\b/,
  },
  {
    signal: "secrets",
    label: "browser credentials",
    pattern: /\b(?:Login Data|Local State)\b|\bKeychains?\b/,
  },
  // MetaMask's extension id: wallet stealers look for its storage directory.
  {
    signal: "secrets",
    label: "wallet",
    pattern: /\bnkbihfbeogaeaoehlefnkodbefgpgknn\b/,
  },
];

/** Every pattern match, line by line. */
export function codeSignals(text: string): SignalHit[] {
  const hits: SignalHit[] = [];
  text.split("\n").forEach((lineText, index) => {
    for (const { signal, label, pattern } of CODE_PATTERNS) {
      if (pattern.test(lineText)) hits.push({ signal, label, line: index + 1 });
    }
  });
  return hits;
}

/**
 * Network plus anything that reaches into the machine or hides code, or
 * eval of decoded data. Network alone is a warning, not an attack.
 */
export function isSuspicious(signals: ReadonlySet<CodeSignal>): boolean {
  const reach =
    signals.has("secrets") ||
    signals.has("process") ||
    signals.has("eval") ||
    signals.has("decode");
  return (
    (signals.has("network") && reach) ||
    (signals.has("eval") && signals.has("decode"))
  );
}

/** "network (x.js:1), secrets (x.js:3)" — each signal once, at its first hit. */
export function describeSignals(
  hits: readonly SignalHit[],
  file: string,
): string {
  const first = new Map<CodeSignal, SignalHit>();
  for (const hit of hits)
    if (!first.has(hit.signal)) first.set(hit.signal, hit);
  return [...first.values()]
    .map((hit) => `${hit.signal} (${file}:${hit.line})`)
    .join(", ");
}

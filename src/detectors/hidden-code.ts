import { codeSignals } from "../signals/code.ts";
import { type HiddenHit, hiddenCode } from "../signals/hidden.ts";
import type { Finding, Severity } from "../verdict.ts";
import type { RepoDetector } from "./index.ts";
import { isInNodeModules } from "./node-modules-present.ts";

const RULE = "repo/hidden-code";
/** Files a toolchain, IDE, or shell may execute or load. */
const SCANNED = /\.(?:[cm]?[jt]sx?|json|sh|bash|zsh|py|rb|pl|ps1)$/;
const MAX_HITS_PER_FILE = 5;
const MAX_SHOWN = 60;

const DESCRIBE: Readonly<Record<HiddenHit["kind"], string>> = {
  offscreen: "code hidden offscreen after a long run of whitespace",
  vertical: "code hidden below hundreds of blank lines",
  bidi: "Unicode bidi control characters that change how the code reads (Trojan Source)",
};

const truncate = (text: string): string =>
  text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;

function severityOf(hit: HiddenHit, path: string): Severity {
  if (hit.kind === "bidi") {
    // RTL locale files legitimately contain bidi isolates.
    return path.endsWith(".json") ? "info" : "warn";
  }
  return codeSignals(hit.hidden).length > 0 ? "block" : "warn";
}

function finding(hit: HiddenHit, path: string): Finding {
  const signals = [...new Set(codeSignals(hit.hidden).map((s) => s.signal))];
  const raw = severityOf(hit, path);
  // Installed and committed dependencies look the same; repo/node-modules-present
  // already flags the directory, so content inside it is at most a warning.
  const severity: Severity =
    isInNodeModules(path) && raw === "block" ? "warn" : raw;
  const detail = hit.kind === "bidi" ? "" : `: \`${truncate(hit.hidden)}\``;
  const using = signals.length > 0 ? ` (uses ${signals.join(", ")})` : "";
  return {
    ruleId: RULE,
    severity,
    file: path,
    line: hit.line,
    message: `${DESCRIBE[hit.kind]} at line ${hit.line}, column ${hit.column}${detail}${using}`,
  };
}

/** Code placed where a human reviewing the file will not see it. */
export const hiddenCodeDetector: RepoDetector = (repo) =>
  repo.entries
    .filter((e) => e.kind === "file" && SCANNED.test(e.path))
    .flatMap((e) =>
      hiddenCode(repo.read(e.path) ?? "")
        .slice(0, MAX_HITS_PER_FILE)
        .map((hit) => finding(hit, e.path)),
    );

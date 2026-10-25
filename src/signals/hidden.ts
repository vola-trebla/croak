/**
 * Facts about code placed where a human reading the file will not see it:
 *
 * - offscreen — after a long run of spaces or tabs on the same line, far past
 *   the right edge of the editor (e.g. a payload after `module.exports = {};`)
 * - vertical  — after hundreds of blank lines, far below the visible code
 * - bidi      — Unicode bidirectional controls that make the displayed text
 *   differ from what runs (Trojan Source, CVE-2021-42574)
 *
 * No verdicts here; detectors weigh these facts with code signals. Character
 * scanning only, no backtracking regexes.
 */

export type HiddenKind = "offscreen" | "vertical" | "bidi";

export interface HiddenHit {
  readonly kind: HiddenKind;
  /** 1-based. */
  readonly line: number;
  /** 1-based column where the hidden text starts. */
  readonly column: number;
  /** The text a reader would miss (the rest of that line). */
  readonly hidden: string;
}

/** Whitespace run, in characters, that pushes code offscreen. */
export const MIN_GAP = 100;
/** Consecutive blank lines that push code below the fold. */
export const MIN_BLANK_LINES = 150;

const isSpace = (ch: string): boolean => ch === " " || ch === "\t";
const BLANK = /^[ \t]*$/;

/** U+202A–U+202E (embeddings/overrides) and U+2066–U+2069 (isolates). */
function isBidiControl(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  );
}

function offscreen(
  line: string,
): { column: number; hidden: string } | undefined {
  let run = 0;
  for (let i = 0; i < line.length; i++) {
    if (isSpace(line[i] ?? "")) {
      run++;
    } else {
      if (run >= MIN_GAP) return { column: i + 1, hidden: line.slice(i) };
      run = 0;
    }
  }
  return undefined;
}

function bidi(line: string): number | undefined {
  for (let i = 0; i < line.length; i++) {
    if (isBidiControl(line.charCodeAt(i))) return i + 1;
  }
  return undefined;
}

export function hiddenCode(text: string): HiddenHit[] {
  const hits: HiddenHit[] = [];
  let blankRun = 0;
  text.split("\n").forEach((raw, index) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const number = index + 1;
    const blank = BLANK.test(line);

    if (!blank && blankRun >= MIN_BLANK_LINES) {
      hits.push({
        kind: "vertical",
        line: number,
        column: 1,
        hidden: line.trimStart(),
      });
    }
    blankRun = blank ? blankRun + 1 : 0;
    if (blank) return;

    const gap = offscreen(line);
    if (gap !== undefined)
      hits.push({ kind: "offscreen", line: number, ...gap });
    const column = bidi(line);
    if (column !== undefined)
      hits.push({
        kind: "bidi",
        line: number,
        column,
        hidden: line.slice(column - 1),
      });
  });
  return hits;
}

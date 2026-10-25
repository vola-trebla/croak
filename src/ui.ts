import type { Severity, Verdict } from "./verdict.ts";

// Every icon is a single wide (2-column) emoji, so text after it stays aligned.
export const VERDICT_ICON: Readonly<Record<Verdict, string>> = {
  allow: "🟢",
  warn: "🟡",
  block: "🔴",
};

export const SEVERITY_ICON: Readonly<Record<Severity, string>> = {
  info: "🔵",
  warn: "🟡",
  block: "🔴",
};

export const INCOMPLETE_ICON = "🟠";

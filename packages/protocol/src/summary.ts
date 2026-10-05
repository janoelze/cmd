// Session summary files (docs/20-session-summaries.md): the marker the core
// writes first, and the text the app copies out of one (as edited).

export const SUMMARY_MARKER = "<!-- cmd:session-summary v1 -->";

/** Headings the core writes itself; the model's body never uses them. */
export const SUMMARY_SECTIONS = { files: "Files changed" } as const;

export const isSummary = (md: string): boolean => md.trimStart().startsWith(SUMMARY_MARKER);

/** A summary to paste elsewhere: without the marker, the "Summarizing…" line and the footer. Null if empty. */
export function summaryText(md: string): string | null {
  const lines = md.split("\n");
  // The footer is a rule, then the "Written by" line; the summary may have rules of its own.
  const footer = lines.findLastIndex((l) => l.trim().startsWith("<sub>"));
  const rule = footer > 0 ? lines.slice(0, footer).findLastIndex((l) => l.trim() === "---") : -1;
  const body = lines.slice(0, rule >= 0 ? rule : lines.length).filter((l) => l.trim() !== SUMMARY_MARKER && !/^\*(Summarizing|Writing)\b.*\*$/.test(l.trim()));
  return body.join("\n").trim() || null;
}

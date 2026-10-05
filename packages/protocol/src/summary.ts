// Session summary files (docs/20-session-summaries.md): the marker the core
// writes first, and the parts the app copies out of one, found by their
// headings, so a summary the user edited copies as edited.

export const SUMMARY_MARKER = "<!-- cmd:session-summary v1 -->";

/** Headings the core writes and summaryPart looks for. */
export const SUMMARY_SECTIONS = { team: "Team update", files: "Files changed" } as const;

export const isSummary = (md: string): boolean => md.trimStart().startsWith(SUMMARY_MARKER);

/**
 * A part of a summary to paste elsewhere: "team" the team message, "ticket"
 * everything above it (title, meta, the summary, files changed). Null if there's none.
 */
export function summaryPart(md: string, part: "team" | "ticket"): string | null {
  const lines = md.split("\n");
  const team = lines.findIndex((l) => l.trim() === `## ${SUMMARY_SECTIONS.team}`);
  // The footer (a rule, then the "Written by" line) belongs to neither; the summary may have rules of its own.
  const footer = lines.findLastIndex((l) => l.trim().startsWith("<sub>"));
  const rule = footer > 0 ? lines.slice(0, footer).findLastIndex((l) => l.trim() === "---") : -1;
  const end = rule > team ? rule : lines.length;
  let body: string[];
  if (part === "team") {
    if (team < 0) return null;
    const next = lines.findIndex((l, i) => i > team && i < end && /^#{1,2} /.test(l));
    body = lines.slice(team + 1, next >= 0 ? next : end);
  } else {
    body = lines.slice(0, team >= 0 ? team : end).filter((l) => l.trim() !== SUMMARY_MARKER && !/^\*(Summarizing|Writing)\b.*\*$/.test(l.trim()));
  }
  return body.join("\n").trim() || null;
}

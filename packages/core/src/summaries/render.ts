// A session summary as Markdown (docs/20-session-summaries.md). The model
// writes a title and a body shaped to the kind of session (SUMMARY_SCHEMA);
// the facts (when, how long, files changed) are rendered
// from what cmd recorded, so they can't be made up. Rendered again from every
// partial answer while it streams.
//
// The app copies it without the marker and footer (protocol summaryText), so
// the marker lives in @cmd/protocol.

import { SUMMARY_MARKER, SUMMARY_SECTIONS } from "@cmd/protocol";

export interface SummaryFacts {
  agent: string;
  project: string;
  cwd: string;
  branch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  prompts: number;
  files: { path: string; change: string }[];
  /** Commits made during the session: for the model, not shown. */
  commits: { hash: string; subject: string }[];
}

/** What the model writes. Field order is the order it streams in. */
export interface SummaryText {
  title: string;
  body: string;
}

// Every key required and no others: OpenAI's strict schemas allow nothing optional.
export const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body"],
  properties: {
    title: { type: "string", description: "What the session was about or achieved, at most 70 characters, no trailing period." },
    body: { type: "string", description: "The summary in Markdown, shaped to the session as the instructions describe." },
  },
} as const;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function when(start: number | null, end: number | null): string | null {
  if (!start) return null;
  const thisYear = new Date().getFullYear();
  const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: new Date(t).getFullYear() === thisYear ? undefined : "numeric" });
  const hm = (t: number) => new Date(t).toTimeString().slice(0, 5);
  if (!end || end - start < 60_000) return `${day(start)}, ${hm(start)}`;
  // Resumed on another day: the days, not a duration that counts the nights.
  if (day(start) !== day(end)) return `${day(start)}, ${hm(start)} – ${day(end)}, ${hm(end)}`;
  const min = Math.round((end - start) / 60_000);
  const dur = min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${day(start)}, ${hm(start)}–${hm(end)} (${dur})`;
}

/** Sections the model wrote only to say there's nothing ("## Next steps" + "None."). */
const EMPTY_SECTION = /^#{1,6} [^\n]+\n+(none|n\/a|nothing( (left|else|further))?|—|-)\.?\s*(?=\n#{1,6} |$)/gim;

/** The body's headings under the title (## and below), and never one the app looks for. */
function demote(md: string): string {
  let fence = false;
  return md
    .replace(EMPTY_SECTION, "")
    .trimEnd()
    .split("\n")
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      if (fence) return l;
      const h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (!h) return l;
      const title = (Object.values(SUMMARY_SECTIONS) as string[]).some((t) => h[2]!.startsWith(t)) ? `${h[2]} (summary)` : h[2];
      return `${"#".repeat(Math.min(6, Math.max(2, h[1]!.length)))} ${title}`;
    })
    .join("\n");
}
const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, "", ...lines, ""] : []);

const MAX_FILES = 40;

export interface RenderState {
  /** Still being written: says so, and what is still missing reads as such. */
  pending?: string | null;
  error?: string | null;
  /** The last line: which model wrote it, from how much. */
  footer?: string | null;
}

/** The summary as Markdown, from the model's (possibly partial) answer and the facts. */
export function renderSummary(facts: SummaryFacts, text: Partial<SummaryText>, state: RenderState = {}): string {
  const meta = [facts.agent, facts.project, facts.branch && `\`${facts.branch}\``, when(facts.startedAt, facts.endedAt), plural(facts.prompts, "prompt")].filter(Boolean).join(" · ");
  const files = facts.files.slice(0, MAX_FILES).map((f) => `- \`${f.path}\`${f.change && f.change !== "M" ? ` (${f.change === "?" ? "new" : f.change === "A" ? "added" : f.change === "D" ? "deleted" : f.change === "R" ? "renamed" : f.change})` : ""}`);
  if (facts.files.length > MAX_FILES) files.push(`- … and ${facts.files.length - MAX_FILES} more`);
  return [
    SUMMARY_MARKER,
    `# ${text.title?.trim() || `Session in ${facts.project}`}`,
    "",
    meta,
    "",
    ...(state.error ? [`> **The summary couldn't be written:** ${state.error}`, ""] : []),
    ...(state.pending ? [`*${state.pending}*`, ""] : []),
    ...(text.body?.trim() ? [demote(text.body.trim()), ""] : []),
    ...section(`${SUMMARY_SECTIONS.files} (${facts.files.length})`, facts.files.length ? files : []),
    ...(state.footer ? ["---", "", `<sub>${state.footer}</sub>`, ""] : []),
  ].join("\n");
}

// What an agent's notification says (the copywriting skill, "Notifications"):
// the title is subject · state, the body the agent's own words, shortened, then
// the facts cmd checked ("4 files changed."). Built from the agent and its
// current turn (docs/18-agent-activity.md); pure. The subject is the agent's
// name (docs/32-session-names.md).

import path from "node:path";
import type { Agent, AgentTurn } from "@cmd/protocol";
import { agentName, outputLanguage } from "@cmd/protocol";

export type NoticeKind = "needs" | "done" | "stopped";

export interface Notice {
  title: string;
  body: string;
}

/** A name longer than this is cut; the state is always whole. */
const SUBJECT_MAX = 28;
const BODY_MAX = 140;
/** The agent's own words in a notification without AI: its first clause, about this long. */
const GIST_MAX = 72;
/** An AI-written body (asked for 70). */
const AI_MAX = 90;

/** Who a notification is about: the agent's name, else its kind ("Claude"); never the project (docs/32-session-names.md). */
export function subjectOf(a: Pick<Agent, "name" | "kind">): string {
  return agentName(a);
}

/** Markdown to plain text: code, links, emphasis, headings and list markers removed. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a word boundary, with an ellipsis. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const at = head.lastIndexOf(" ");
  return `${(at > max * 0.6 ? head.slice(0, at) : head).replace(/[\s,;:–-]+$/, "")}…`;
}

/** The first sentence of an agent's message (two if the first is very short), as plain text. */
export function gist(md: string, max = BODY_MAX): string {
  // A heading names a section, it isn't something the agent said: "## What a name is for" then the text ran together.
  const text = plain(md.replace(/^\s{0,3}#{1,6}\s.*$/gm, "")) || plain(md);
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  // A filler opener ("Sure.", "Good idea.", "Yes.") says nothing on its own: the next sentence does.
  let out = sentences[0] ?? text;
  if (FILLER.test(out) && sentences[1]) out = sentences[1];
  if (out.length <= max) return out;
  // Long: end at a clause boundary before the limit, else at a word.
  const head = out.slice(0, max);
  const at = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(" — "));
  return at > max * 0.45 ? `${head.slice(0, at)}…` : cut(out, max);
}

const FILLER = /^(sure|yes|no|ok(ay)?|done|great|got it|right|partly|perfect|absolutely|good (idea|question|catch|point)|makes sense|understood|will do)[.!,:]?$/i;

/** What cmd checked about a finished turn: "4 files changed." */
function facts(t: AgentTurn | null | undefined): string {
  if (!t?.files.length) return "";
  return `${t.files.length} file${t.files.length === 1 ? "" : "s"} changed.`;
}

const quote = (s: string) => `“${s}”`;

/** What a waiting agent asks, said plainly. */
function asking(a: Agent): string {
  const ask = a.turn?.ask;
  if (ask?.input) {
    const input = cut(ask.input, 80);
    const edit = /edit|write|patch|replace/i.test(ask.tool ?? "") && !/\s/.test(ask.input);
    return edit ? `Allow editing ${quote(path.basename(input))}?` : `Allow ${quote(input)}?`;
  }
  return ask?.message ?? a.detail ?? "Waiting for you";
}

export function agentNotice(a: Agent, kind: NoticeKind): Notice {
  const subject = subjectOf(a);
  const t = a.turn;
  let state: string = kind === "needs" ? "needs you" : kind;
  if (kind === "done" && t?.background.length) state = `done, ${t.background.length} task${t.background.length === 1 ? "" : "s"} still running`;
  const title = `${cut(subject, SUBJECT_MAX)} · ${state}`;
  if (kind === "needs") return { title, body: cut(asking(a), BODY_MAX) };
  if (kind === "stopped") return { title, body: gist(t?.error ?? a.detail ?? "The request failed.") };
  const said = t?.final ?? a.lastMessage ?? "";
  const known = facts(t);
  const words = said ? gist(said, GIST_MAX) : "";
  return { title, body: [words, known].filter(Boolean).join(" ") };
}

// ── AI wording ──────────────────────────────────────────────
// With an AI provider set up (notifications.ai, on by default), the body is
// written by the fast tier from the turn's context; the title stays cmd's own
// (subject · state). Falls back to agentNotice's body when slow or unavailable.

export const NOTICE_SYSTEM = `You write the body of a macOS notification about a coding agent, for the developer who started it. They glance at it for a second.

- One short line, at most 70 characters. Fragments are fine. Snappy, like a teammate's one-line update.
- The result, not the process. Never retell steps, never copy the agent's wording, no filler ("Yes.", "Sure.", "Done.", "Good idea.", "Partly."). Don't overstate: proposed isn't done, started isn't finished.
- done: what came out of it, in a few words. Only if its last message ends by asking the developer something, add what it asks ("Asks whether to merge."). Never "Wants to" for done.
- needs: "Wants to" + what it wants to do, with the exact command or file.
- stopped: why, and when it can go on if that's known.
- Only facts from the input. No invented results, numbers or files.
- The title already says the agent's name and the state. Don't repeat them, and don't start with the name.
- Write in the input's language.
- Plain text. No Markdown, emoji, exclamation marks or quotes around the line. Don't start with "The agent" or "I".

Examples:
Fixed add(); tests pass.
Summaries are committed on the summary branch.
v0.11.0 is out, signed and notarized.
Done. Asks whether to merge.
Wants to run rm NOTES.md.
Wants to edit calc.py.
Weekly limit hit. Resets Oct 7, 3 am.`;

/** What the model gets: the turn's facts, cut to size. */
export function noticeContext(a: Agent, kind: NoticeKind): Record<string, unknown> {
  const t = a.turn;
  const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined);
  return {
    state: kind,
    name: subjectOf(a),
    language: outputLanguage().name,
    agent: a.kind,
    prompt: clip(t?.prompt ?? a.lastPrompt, 600),
    promptFromAgent: t?.auto || undefined,
    followUps: t?.followUps.length ? t.followUps.map((f) => clip(f, 200)) : undefined,
    finalMessage: kind !== "needs" ? clip(t?.final ?? a.lastMessage, 1500) : undefined,
    asking: kind === "needs" ? (t?.ask ?? { message: a.detail }) : undefined,
    error: kind === "stopped" ? clip(t?.error ?? a.detail, 300) : undefined,
    filesChanged: t?.files.length ? t.files.slice(0, 15).map((f) => path.basename(f.path)) : undefined,
    moreFiles: t && t.files.length > 15 ? t.files.length - 15 : undefined,
    stillRunning: t?.background.length ? t.background : undefined,
    agentNote: t?.notes.length ? clip(t.notes.at(-1), 300) : undefined,
  };
}

/** A model's answer made safe for a notification body: one line, plain, short. */
export function cleanAiBody(text: string): string | null {
  let s = plain(text.split("\n").find((l) => l.trim()) ?? "").replace(/^["“'](.*)["”']$/s, "$1").trim();
  if (!s || s.length < 4) return null;
  if (!/[.?!…]$/.test(s)) s += ".";
  return cut(s, AI_MAX);
}

// What an agent's notification says (the copywriting skill, "Notifications"):
// the title is subject · state, the body the agent's own words, shortened, then
// the facts cmd checked ("4 files changed, 7 min."). Built from the agent and its
// current turn (docs/18-agent-activity.md); pure apart from finding the project.

import path from "node:path";
import type { Agent, AgentTurn } from "@cmd/protocol";
import { checkoutOf } from "./peers.ts";

export type NoticeKind = "needs" | "done" | "stopped";

export interface Notice {
  title: string;
  body: string;
}

/** A project name longer than this is cut; the state is always whole. */
const SUBJECT_MAX = 28;
const BODY_MAX = 140;

/** The agent's name if it has one, else its project: the checkout's folder, else its folder. */
export function subjectOf(a: Pick<Agent, "name" | "cwd" | "kind">): string {
  if (a.name) return a.name;
  const root = a.cwd ? (checkoutOf(a.cwd)?.root ?? a.cwd) : "";
  return path.basename(root) || a.kind;
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
  const text = plain(md);
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  let out = sentences[0] ?? text;
  if (out.length < 30 && sentences[1]) out = `${out} ${sentences[1]}`;
  return cut(out, max);
}

/** 40 s, 7 min, 1 h 5 min. */
export function shortDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** What cmd checked about a finished turn: "4 files changed, 7 min." */
function facts(t: AgentTurn | null | undefined): string {
  if (!t) return "";
  const parts: string[] = [];
  if (t.files.length) parts.push(`${t.files.length} file${t.files.length === 1 ? "" : "s"} changed`);
  if (t.endedAt) parts.push(shortDuration(t.endedAt - t.startedAt));
  return parts.length ? `${parts.join(", ")}.` : "";
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
  const words = said ? gist(said, BODY_MAX - (known ? known.length + 1 : 0)) : "";
  return { title, body: [words, known].filter(Boolean).join(" ") };
}

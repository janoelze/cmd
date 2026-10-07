// Journal events from what cmd already kept before the journal existed, or
// while it wasn't running: agent turns from the activity log (14 days), agent
// sessions from the transcript index (as far back as the agents keep them) and
// git's reflogs (90 days). Keys match the live recorder's, so a backfill over
// recorded days changes nothing but adds what was missed.

import path from "node:path";
import type { SessionRow } from "../data/views/sessions.ts";
import type { AgentTurn } from "@cmd/protocol";
import type { NewJournalEvent } from "./store.ts";

/** Transcript folders that are scratch, not work (agents' temp dirs, recordings). */
const SCRATCH = /^\/(private\/)?(tmp|var\/folders)\//;

export const clip = (s: string | null | undefined, n: number) => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

import { projectOf } from "../data/project.ts";
export { projectOf };

/** A folder's project (projectOf); a caller reading many events passes one that remembers. */
export type ProjectOf = (cwd: string) => string | null;

/** projectOf, remembering each folder's answer (it walks the folder's parents): for one read of many events. */
export function projectsOnce(): ProjectOf {
  const seen = new Map<string, string | null>();
  return (cwd) => {
    let p = seen.get(cwd);
    if (p === undefined) seen.set(cwd, (p = projectOf(cwd)));
    return p;
  };
}

/** Agent sessions from the sessions view (data/views/sessions.ts). */
export function sessionEvents(rows: SessionRow[], project: ProjectOf = projectOf): NewJournalEvent[] {
  return rows.filter((r): r is SessionRow & { started: number } => r.started !== null).map((r) => {
    const title = r.title?.trim() || null;
    return {
      at: r.started,
      until: Math.max(r.updated ?? r.started, r.started),
      kind: "agent.session",
      key: `session:${r.id}`,
      spaceId: null,
      repo: r.cwd && !SCRATCH.test(r.cwd) ? project(r.cwd) : null,
      cwd: r.cwd,
      thread: `session:${r.id}`,
      text: title ?? clip(oneLine(r.first_prompt ?? ""), 80) ?? "Agent session",
      data: { kind: "agent.session", agent: r.agent, sessionId: r.id, title, firstPrompt: clip(r.first_prompt, 600), branch: r.branch || null },
      source: "backfill",
    };
  });
}

/** A turn as a journal event. `cwd`: where its agent ran. */
export function turnEvent(t: AgentTurn, cwd: string | null, source: "live" | "backfill", project: ProjectOf = projectOf): NewJournalEvent {
  const prompt = t.prompt ? oneLine(t.prompt) : null;
  return {
    at: t.startedAt,
    until: t.endedAt ?? t.startedAt,
    kind: "agent.turn",
    key: `turn:${t.agentId}:${t.index}`,
    spaceId: null,
    repo: cwd && !SCRATCH.test(cwd) ? project(cwd) : null,
    cwd,
    thread: t.sessionId ? `session:${t.sessionId}` : `agent:${t.agentId}`,
    text: clip(prompt, 120) ?? "(a turn that began before cmd saw it)",
    data: {
      kind: "agent.turn",
      agent: t.agentKind,
      sessionId: t.sessionId,
      agentId: t.agentId,
      prompt: clip(t.prompt, 2000),
      auto: t.auto,
      followUps: t.followUps.map((f) => clip(f, 600)!).slice(0, 8),
      final: clip(t.final, 1500),
      outcome: t.outcome,
      error: clip(t.error, 400),
      files: t.files.map((f) => f.path).slice(0, 60),
      commands: t.commands.slice(-12),
      tools: t.tools.reduce((n, x) => n + x.count, 0),
    },
    source,
  };
}

/** Turns from the turns view (data/views/activity.ts), each with where its agent ran. */
export function turnEvents(turns: { turn: AgentTurn; cwd: string | null }[]): NewJournalEvent[] {
  return turns.map(({ turn, cwd }) => turnEvent(turn, cwd, "backfill"));
}

export const isScratch = (cwd: string | null) => !!cwd && SCRATCH.test(cwd);
export const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
export const base = (p: string | null) => (p ? path.basename(p) : null);

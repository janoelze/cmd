// Journal events from what cmd already kept before the journal existed, or
// while it wasn't running: agent turns from the activity log (14 days), agent
// sessions from the transcript index (as far back as the agents keep them) and
// git's reflogs (90 days). Keys match the live recorder's, so a backfill over
// recorded days changes nothing but adds what was missed.

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTurn } from "@cmd/protocol";
import { decodeRows, decodeTurn } from "../stored.ts";
import { repoOfSync } from "./git.ts";
import type { NewJournalEvent } from "./store.ts";

/** Transcript folders that are scratch, not work (agents' temp dirs, recordings). */
const SCRATCH = /^\/(private\/)?(tmp|var\/folders)\//;

export const clip = (s: string | null | undefined, n: number) => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The project a folder belongs to: its repository's main worktree, else the folder. */
export function projectOf(cwd: string | null): string | null {
  if (!cwd) return null;
  return repoOfSync(cwd)?.repo ?? cwd;
}

/** Agent sessions from the transcript index (search.sqlite's sessions table). */
export function sessionEvents(search: DatabaseSync, since: number): NewJournalEvent[] {
  const rows = search.prepare(`SELECT id, agent, cwd, branch, title, first_prompt, started, updated FROM sessions WHERE updated >= ? AND started IS NOT NULL`).all(since) as {
    id: string;
    agent: string;
    cwd: string | null;
    branch: string | null;
    title: string | null;
    first_prompt: string | null;
    started: number;
    updated: number | null;
  }[];
  return rows.map((r) => {
    const title = r.title?.trim() || null;
    return {
      at: r.started,
      until: Math.max(r.updated ?? r.started, r.started),
      kind: "agent.session",
      key: `session:${r.id}`,
      spaceId: null,
      repo: r.cwd && !SCRATCH.test(r.cwd) ? projectOf(r.cwd) : null,
      cwd: r.cwd,
      thread: `session:${r.id}`,
      text: title ?? clip(oneLine(r.first_prompt ?? ""), 80) ?? "Agent session",
      data: { kind: "agent.session", agent: r.agent, sessionId: r.id, title, firstPrompt: clip(r.first_prompt, 600), branch: r.branch || null },
      source: "backfill",
    };
  });
}

/** A turn as a journal event. `cwd`: where its agent ran. */
export function turnEvent(t: AgentTurn, cwd: string | null, source: "live" | "backfill"): NewJournalEvent {
  const prompt = t.prompt ? oneLine(t.prompt) : null;
  return {
    at: t.startedAt,
    until: t.endedAt ?? t.startedAt,
    kind: "agent.turn",
    key: `turn:${t.agentId}:${t.index}`,
    spaceId: null,
    repo: cwd && !SCRATCH.test(cwd) ? projectOf(cwd) : null,
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

/** Turns from the activity log (agent_turns), each with its agent's folder from the events (agent_events). */
export function turnEvents(db: DatabaseSync, since: number): NewJournalEvent[] {
  const cwdOf = new Map<string, string>();
  for (const r of db.prepare(`SELECT agent_id, json_extract(doc, '$.cwd') AS cwd FROM agent_events WHERE agent_id IS NOT NULL AND json_extract(doc, '$.cwd') IS NOT NULL AND at >= ? GROUP BY agent_id`).all(since - 86400_000) as { agent_id: string; cwd: string }[])
    cwdOf.set(r.agent_id, r.cwd);
  const rows = db.prepare(`SELECT doc FROM agent_turns WHERE started_at >= ? ORDER BY started_at`).all(since) as { doc: string }[];
  return decodeRows("turn", rows.map((r) => r.doc), decodeTurn).map((t) => turnEvent(t, cwdOf.get(t.agentId) ?? null, "backfill"));
}

export const isScratch = (cwd: string | null) => !!cwd && SCRATCH.test(cwd);
export const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
export const base = (p: string | null) => (p ? path.basename(p) : null);

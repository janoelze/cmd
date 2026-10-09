// Today's tables as events (docs/28 §5, "Imports"): the activity log's raw hook
// payloads and the journal's live kinds, read from a cmd.sqlite. Derived kinds
// (agent.turn, agent.session) are left out: they become views. Used by the
// spike and, once, by the phase-1 migration.
// Remove once installs from before the event log (cmd ≤ 0.15) have started a newer cmd once: the import runs at most once per install.

import type { DatabaseSync } from "node:sqlite";
import { FLAG_IMPORTED } from "../schema.ts";
import type { DataEventType } from "@cmd/protocol";
import type { StoreEvent as NewEvent } from "../store.ts";
import { projectIdOf } from "../project.ts";

interface HookRow {
  id: number;
  at: number;
  pane_id: string | null;
  agent_id: string | null;
  agent: string | null;
  source: string;
  name: string;
  doc: string;
  env: string | null;
  schema: number | null;
  cmd: string | null;
  hook: number | null;
  agent_version: string | null;
  session_id: string | null;
}

/** agent_events → `agent.hook` events; PostToolUse rows get their PreToolUse as parent (tool_use_id). */
export function* hookEvents(db: DatabaseSync): Generator<NewEvent> {
  const starts = new Map<string, string>();
  for (const r of db.prepare(`SELECT * FROM agent_events ORDER BY id`).iterate() as Iterable<HookRow>) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.doc) as Record<string, unknown>;
    } catch {}
    const id = `hook:${r.pane_id ?? "-"}:${Math.round(r.at * 1000)}:${r.name}:${r.id}`;
    const toolId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
    let parentId: string | null = null;
    if (toolId && r.pane_id) {
      const key = `${r.pane_id}:${toolId}`;
      if (r.name === "PreToolUse") starts.set(key, id);
      else if (starts.has(key)) parentId = starts.get(key)!;
    }
    const text = typeof payload.prompt === "string" ? firstLine(payload.prompt) : typeof payload.tool_name === "string" ? `${payload.tool_name}` : typeof payload.last_assistant_message === "string" ? firstLine(payload.last_assistant_message) : r.name;
    yield {
      id,
      at: r.at,
      type: r.source === "core" ? "agent.note" : "agent.hook",
      source: r.source === "core" ? `cmd:${r.cmd ?? "?"}` : `hook:${r.agent ?? "?"}${r.agent_version ? `@${r.agent_version}` : ""}`,
      parentId,
      sessionId: r.session_id ? `${r.agent ?? "agent"}:${r.session_id}` : null,
      agentId: r.agent_id,
      paneId: r.pane_id,
      projectId: projectIdOf(typeof payload.cwd === "string" ? payload.cwd : null),
      text,
      body: typeof payload.prompt === "string" ? payload.prompt : typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : null,
      data: { name: r.name, agent: r.agent, env: r.env ? JSON.parse(r.env) : undefined, hook: r.hook, schema: r.schema, payload },
      flags: FLAG_IMPORTED,
    };
  }
}

/** remote_log (the remote access audit) → `remote.audit` events. */
export function* remoteAudit(db: DatabaseSync): Generator<NewEvent> {
  let n = 0;
  for (const r of db.prepare(`SELECT at, kind, device_id, detail FROM remote_log ORDER BY at`).iterate() as Iterable<{ at: number; kind: string; device_id: string | null; detail: string | null }>)
    yield { id: `remote:import:${r.at}:${n++}`, at: r.at, type: "remote.audit", source: "import:remote_log", deviceId: r.device_id, text: `${r.kind}${r.detail ? `: ${r.detail}` : ""}`, data: { kind: r.kind, detail: r.detail }, flags: FLAG_IMPORTED };
}

interface JournalRow {
  id: number;
  at: number;
  until: number | null;
  kind: string;
  key: string;
  space_id: string | null;
  repo: string | null;
  cwd: string | null;
  thread: string | null;
  text: string;
  data: string;
  source: string;
  cmd: string | null;
}

/** journal_events (live kinds and git) → events; agent.* kinds are derived and skipped. */
export function* journalEvents(db: DatabaseSync): Generator<NewEvent> {
  for (const r of db.prepare(`SELECT * FROM journal_events WHERE kind NOT LIKE 'agent.%' ORDER BY id`).iterate() as Iterable<JournalRow>) {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(r.data) as Record<string, unknown>;
    } catch {}
    const paneId = typeof data.paneId === "string" ? data.paneId : null;
    const windowId = typeof data.windowId === "string" ? data.windowId : null;
    yield {
      id: r.key,
      at: r.at,
      until: r.until,
      type: r.kind as DataEventType,
      source: r.source === "live" ? `cmd:${r.cmd ?? "?"}` : "git",
      workspaceId: r.space_id,
      projectId: r.repo ? `dir:${r.repo}` : r.cwd ? `dir:${r.cwd}` : null,
      paneId,
      windowId,
      text: r.text,
      body: r.kind === "note" || r.kind === "git.commit" ? r.text : null,
      data,
      flags: FLAG_IMPORTED,
    };
  }
}

const firstLine = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 300);

// Where the Operator's conversations are kept (docs/51), in cmd's database: each workspace's
// current one (operator_conversations), and the ones New Conversation put away (operator_past),
// to open again. Without a database (tests) nothing is kept. The approvals the person chose to
// remember were kept here (operator_grants) before every caller of the tools shared them
// (tools/approvals.ts): moved there once.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ModelMessage } from "ai";
import type { AgentId, AgentState, OperatorItem, OperatorPast, OperatorUsage, PaneId, WindowId, WorkspaceId } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";

const log = logger("operator");

/** A conversation as kept. */
export interface Saved {
  name?: string | null;
  items: OperatorItem[];
  messages: ModelMessage[];
  refs: Record<string, WindowId>;
  system: string | null;
  rules?: string | null;
  agents?: [AgentId, AgentState][];
  commands?: [PaneId, { label: string; url: string | null }][];
  usage: OperatorUsage;
  model: string | null;
}

export class ConversationStore {
  #db: DatabaseSync | null;

  constructor(db: DatabaseSync | null) {
    this.#db = db;
    db?.exec(`CREATE TABLE IF NOT EXISTS operator_conversations (workspace_id TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)`);
    db?.exec(`CREATE TABLE IF NOT EXISTS operator_past (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, at INTEGER NOT NULL, requests INTEGER NOT NULL, json TEXT NOT NULL)`);
    db?.exec(`CREATE INDEX IF NOT EXISTS operator_past_ws ON operator_past (workspace_id, at)`);
    // Remembered approvals from before they were shared: into remembered_approvals (Approvals made it), once.
    try {
      if (db?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operator_grants'").get())
        db.exec(`INSERT OR IGNORE INTO remembered_approvals (workspace_id, key, label, at) SELECT workspace_id, key, label, at FROM operator_grants; DROP TABLE operator_grants`);
    } catch (e) {
      log.warn(`could not move the remembered approvals: ${(e as Error).message}`);
    }
  }

  /** Workspaces that have a conversation. */
  workspaces(): WorkspaceId[] {
    return ((this.#db?.prepare("SELECT workspace_id FROM operator_conversations").all() ?? []) as { workspace_id: string }[]).map((r) => r.workspace_id);
  }

  load(workspaceId: WorkspaceId): Saved | null {
    try {
      const row = this.#db?.prepare("SELECT json FROM operator_conversations WHERE workspace_id = ?").get(workspaceId) as { json: string } | undefined;
      return row ? (JSON.parse(row.json) as Saved) : null;
    } catch {
      return null;
    }
  }

  /** null: there is nothing to keep. */
  save(workspaceId: WorkspaceId, saved: Saved | null): void {
    if (!this.#db) return;
    try {
      if (!saved) this.#db.prepare("DELETE FROM operator_conversations WHERE workspace_id = ?").run(workspaceId);
      else this.#db.prepare("INSERT OR REPLACE INTO operator_conversations (workspace_id, json, at) VALUES (?, ?, ?)").run(workspaceId, JSON.stringify(saved), Date.now());
    } catch (e) {
      log.warn(`could not save the conversation: ${(e as Error).message}`);
    }
  }

  /** Into the past conversations. */
  putAway(workspaceId: WorkspaceId, past: Omit<OperatorPast, "id">, saved: Saved): void {
    this.#db?.prepare("INSERT INTO operator_past (id, workspace_id, title, at, requests, json) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), workspaceId, past.title, past.at, past.requests, JSON.stringify(saved));
  }

  history(workspaceId: WorkspaceId): OperatorPast[] {
    return (this.#db?.prepare("SELECT id, title, at, requests FROM operator_past WHERE workspace_id = ? ORDER BY at DESC LIMIT 100").all(workspaceId) ?? []) as unknown as OperatorPast[];
  }

  /** A past conversation, taken out of the past ones; null when it is gone. */
  take(workspaceId: WorkspaceId, id: string): Saved | null {
    const row = this.#db?.prepare("SELECT json FROM operator_past WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as { json: string } | undefined;
    if (!row) return null;
    this.#db!.prepare("DELETE FROM operator_past WHERE id = ?").run(id);
    return JSON.parse(row.json) as Saved;
  }
}

// Approvals (docs/54, docs/51 Guardrails): tool calls waiting for the person, whoever made them,
// answered through approvals.answer from wherever the app shows them (the Operator's chat, the
// window acted on); and the ones the person chose to remember, per workspace, in cmd's database
// (remembered_approvals). Without a database (tests) nothing is remembered.

import type { DatabaseSync } from "node:sqlite";
import type { RememberedApproval, WorkspaceId } from "@cmd/protocol";

export interface Answer {
  allow: boolean;
  reason?: string;
  remember?: boolean;
}

export class Approvals {
  #db: DatabaseSync | null;
  #waiting = new Map<string, { workspaceId: WorkspaceId; resolve: (a: Answer) => void }>();

  constructor(db: DatabaseSync | null) {
    this.#db = db;
    db?.exec(`CREATE TABLE IF NOT EXISTS remembered_approvals (workspace_id TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (workspace_id, key))`);
  }

  /** Wait for the person's answer to call `id`; a stop (cancel) answers no. */
  wait(id: string, workspaceId: WorkspaceId): Promise<Answer> {
    return new Promise((resolve) => this.#waiting.set(id, { workspaceId, resolve }));
  }

  waiting(id: string): boolean {
    return this.#waiting.has(id);
  }

  answer(workspaceId: WorkspaceId, id: string, a: Answer): void {
    const w = this.#waiting.get(id);
    if (!w || w.workspaceId !== workspaceId) throw new Error("nothing is waiting for that answer");
    this.#waiting.delete(id);
    w.resolve({ allow: a.allow, reason: a.reason?.trim() || undefined, remember: a.allow && !!a.remember });
  }

  /** No answer is coming (the caller stopped or went away): it is a no. */
  cancel(id: string, reason: string): void {
    const w = this.#waiting.get(id);
    if (!w) return;
    this.#waiting.delete(id);
    w.resolve({ allow: false, reason });
  }

  // ── remembered ─────────────────────────────────────────

  list(workspaceId: WorkspaceId): RememberedApproval[] {
    return (this.#db?.prepare("SELECT key, label, at FROM remembered_approvals WHERE workspace_id = ? ORDER BY at DESC").all(workspaceId) ?? []) as unknown as RememberedApproval[];
  }

  remembered(workspaceId: WorkspaceId, key: string): RememberedApproval | null {
    return (this.#db?.prepare("SELECT key, label, at FROM remembered_approvals WHERE workspace_id = ? AND key = ?").get(workspaceId, key) as RememberedApproval | undefined) ?? null;
  }

  remember(workspaceId: WorkspaceId, key: string, label: string, at = Date.now()): void {
    this.#db?.prepare("INSERT OR REPLACE INTO remembered_approvals (workspace_id, key, label, at) VALUES (?, ?, ?, ?)").run(workspaceId, key, label, at);
  }

  forget(workspaceId: WorkspaceId, key: string): void {
    this.#db?.prepare("DELETE FROM remembered_approvals WHERE workspace_id = ? AND key = ?").run(workspaceId, key);
  }
}

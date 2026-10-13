// Approvals (docs/55): whether a tool call may run, asks the person, or is refused. Every call
// that acts is a kind of action (a Permission: open websites, type into terminals…) with a level
// in Settings → Agents → Permissions: ask, allow or never. A yes holds once, for the caller's
// session (in memory, until its agent exits) or always in the workspace (remembered_approvals,
// keyed by the permission and, for those kept by site, the site). Risky actions always ask and
// are never kept for always. Calls waiting for the person are answered through approvals.answer
// from wherever the app shows them (the approval sheet, the Operator's chat).

import type { DatabaseSync } from "node:sqlite";
import { PERMISSIONS, approvalKey, approvalLabel, type ApprovalScope, type Permission, type PermissionLevel, type RememberedApproval, type WorkspaceId } from "@cmd/protocol";
import type { Approval } from "./kit.ts";

export interface Answer {
  allow: boolean;
  reason?: string;
  scope?: ApprovalScope;
}

/** What happens to a call: it runs (`kept`: the answer that lets it, in words), it asks with these scopes, or it is refused with a message for the caller. */
export type Decision = { run: true; kept?: string } | { ask: ApprovalScope[] } | { refuse: string };

const SCOPES: ApprovalScope[] = ["once", "session", "always"];

export class Approvals {
  #db: DatabaseSync | null;
  #levels: () => Record<Permission, PermissionLevel>;
  #waiting = new Map<string, { workspaceId: WorkspaceId; resolve: (a: Answer) => void }>();
  /** Per caller (a pane, the Operator's conversation), what it may do for the rest of its session. */
  #session = new Map<string, Set<string>>();

  constructor(db: DatabaseSync | null, levels: () => Record<Permission, PermissionLevel>) {
    this.#db = db;
    this.#levels = levels;
    db?.exec(`CREATE TABLE IF NOT EXISTS remembered_approvals (workspace_id TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (workspace_id, key))`);
    // Answers kept before permissions (url:…, type:…, page:site:fill) say nothing now.
    const known = PERMISSIONS.map((p) => `key != '${p.id}' AND key NOT LIKE '${p.id}:%'`).join(" AND ");
    db?.exec(`DELETE FROM remembered_approvals WHERE ${known}`);
  }

  /** What happens to a call `caller` makes in a workspace (docs/55, "How a call is decided"). */
  decide(caller: string, workspaceId: WorkspaceId, a: Approval): Decision {
    if (a.free) return { run: true };
    const level = this.#levels()[a.permission] ?? "ask";
    const title = approvalLabel(a.permission);
    if (level === "never") return { refuse: `Refused: “${title}” is set to Never in cmd (Settings → Agents → Permissions). Ask the person to change it if this is needed.` };
    const key = approvalKey(a.permission, a.site);
    if (this.#session.get(caller)?.has(key)) return { run: true, kept: "this session" };
    if (a.risky) return { ask: ["once", "session"] };
    if (level === "allow") return { run: true };
    const kept = this.remembered(workspaceId, key);
    if (kept) return { run: true, kept: kept.label };
    return { ask: SCOPES };
  }

  /** Keeps a yes for as long as the person said. */
  grant(caller: string, workspaceId: WorkspaceId, a: Approval, scope: ApprovalScope = "once"): void {
    const key = approvalKey(a.permission, a.site);
    if (scope === "session") {
      const s = this.#session.get(caller) ?? new Set<string>();
      this.#session.set(caller, s.add(key));
    } else if (scope === "always" && !a.risky) this.remember(workspaceId, key, approvalLabel(a.permission, a.site));
  }

  /** The caller's session ended (its agent exited, its pane closed): what it was allowed for it goes. */
  endSession(caller: string): void {
    this.#session.delete(caller);
  }

  // ── waiting for the person ─────────────────────────────

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
    w.resolve({ allow: a.allow, reason: a.reason?.trim() || undefined, ...(a.allow ? { scope: a.scope ?? "once" } : {}) });
  }

  /** No answer is coming (the caller stopped or went away): it is a no. */
  cancel(id: string, reason: string): void {
    const w = this.#waiting.get(id);
    if (!w) return;
    this.#waiting.delete(id);
    w.resolve({ allow: false, reason });
  }

  // ── kept for always ────────────────────────────────────

  /** Kept approvals of a workspace, or of every workspace, newest first. */
  list(workspaceId?: WorkspaceId): RememberedApproval[] {
    const rows = workspaceId
      ? this.#db?.prepare("SELECT workspace_id AS workspaceId, key, label, at FROM remembered_approvals WHERE workspace_id = ? ORDER BY at DESC").all(workspaceId)
      : this.#db?.prepare("SELECT workspace_id AS workspaceId, key, label, at FROM remembered_approvals ORDER BY at DESC").all();
    return (rows ?? []) as unknown as RememberedApproval[];
  }

  remembered(workspaceId: WorkspaceId, key: string): RememberedApproval | null {
    return (this.#db?.prepare("SELECT workspace_id AS workspaceId, key, label, at FROM remembered_approvals WHERE workspace_id = ? AND key = ?").get(workspaceId, key) as RememberedApproval | undefined) ?? null;
  }

  remember(workspaceId: WorkspaceId, key: string, label: string, at = Date.now()): void {
    this.#db?.prepare("INSERT OR REPLACE INTO remembered_approvals (workspace_id, key, label, at) VALUES (?, ?, ?, ?)").run(workspaceId, key, label, at);
  }

  forget(workspaceId: WorkspaceId, key: string): void {
    this.#db?.prepare("DELETE FROM remembered_approvals WHERE workspace_id = ? AND key = ?").run(workspaceId, key);
  }
}

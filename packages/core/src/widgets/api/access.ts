// What each verb and topic of the widget API needs (docs/56, "Capabilities and grants"): one
// row per ApiVerb and ApiTopic, typed so a new one fails tsc until someone decides, the way
// TOOL_ACCESS is for the core's methods. `needs` is the permission (as package.json writes
// it); `mode` says whether it reads (at once, within the grant), acts (at once, marked) or
// confirms (asks the person each call, phase 4). The adapter (v1.ts) checks the row first.

import type { ApiError, ApiTopic, ApiVerb, WidgetPermissions } from "@cmd/protocol";

/**
 * - "workspace": `workspace: ["read"]` (the widget's own workspace; "all" for every one).
 * - "events": `events: [<class>]`, decided per query by data/policy.ts's widget row.
 * - "net": `net: [<host>]`, decided per URL.
 * - "ai": `ai: ["complete"]`.
 * - null: nothing beyond being a widget (its own state, its own notifications, selecting a window).
 */
export type Need = "workspace" | "events" | "net" | "ai" | null;

export interface AccessRow {
  needs: Need;
  mode: "read" | "act" | "confirm";
}

const read = (needs: Need): AccessRow => ({ needs, mode: "read" });
const act = (needs: Need): AccessRow => ({ needs, mode: "act" });

export const API_ACCESS: { [V in ApiVerb]: AccessRow } = {
  "workspace.get": read("workspace"),
  "workspace.windows": read("workspace"),
  "workspace.selected": read("workspace"),
  "agents.list": read("workspace"),
  "agents.get": read("workspace"),
  "terminals.list": read("workspace"),
  "terminals.read": read("workspace"),
  "terminals.waitFor": read("workspace"),
  "windows.list": read("workspace"),
  "windows.open": act(null), // only right after the person pressed something in the widget
  "windows.select": act(null), // within the widget's scope: its workspace, or all with "all"
  "events.query": read("events"),
  "events.stats": read("events"),
  "git.status": read("workspace"),
  "git.diff": read("workspace"),
  "git.worktrees": read("workspace"),
  "actions.list": read("workspace"),
  "notify.send": act(null), // through the notification center, muted with the window; no permission key for it in API 1
  "state.get": read(null),
  "state.set": act(null),
  "state.history": act(null),
  "net.fetch": read("net"),
  "ai.complete": read("ai"),
};

export const TOPIC_ACCESS: { [T in ApiTopic]: AccessRow } = {
  workspace: read("workspace"),
  agents: read("workspace"),
  terminals: read("workspace"),
  windows: read("workspace"),
  events: read("events"),
  git: read("workspace"),
  actions: read("workspace"),
};

/** What a grant lets a widget do with the parts of the workspace: nothing, its own workspace, or every one. */
export function workspaceScope(p: WidgetPermissions): "none" | "workspace" | "all" {
  if (p.workspace.includes("all")) return "all";
  return p.workspace.includes("read") ? "workspace" : "none";
}

/** A permission as package.json's cmd.permissions writes it: `net: ["api.github.com"]`. */
export const permissionText = (key: keyof WidgetPermissions, value: string): string => `${key}: ${JSON.stringify([value])}`;

/** A verb refused or failed, as the process gets it (`result` with ok: false); the process lives on. */
export class ApiRefusal extends Error {
  readonly error: ApiError;
  constructor(error: ApiError) {
    super(error.message);
    this.error = error;
  }
}

/** The refusal for a missing permission, naming what to add. */
export const missing = (key: keyof WidgetPermissions, value: string, what: string): ApiRefusal =>
  new ApiRefusal({ code: "permission", permission: permissionText(key, value), message: `${what} needs ${permissionText(key, value)} in package.json's cmd.permissions.` });

export const invalid = (message: string): ApiRefusal => new ApiRefusal({ code: "invalid", message });
export const failed = (message: string): ApiRefusal => new ApiRefusal({ code: "failed", message });

/** At most `max` calls in any `perMs`: what a process may send through net.fetch, ai.complete, notify.send. */
export class RateLimit {
  #at: number[] = [];
  readonly max: number;
  readonly perMs: number;
  constructor(max: number, perMs = 60_000) {
    this.max = max;
    this.perMs = perMs;
  }
  /** Count a call; refused (with the limit named) when it is one too many. */
  take(what: string, now = Date.now()): void {
    this.#at = this.#at.filter((t) => now - t < this.perMs);
    if (this.#at.length >= this.max) throw failed(`${what}: at most ${this.max} a minute; try again shortly.`);
    this.#at.push(now);
  }
}

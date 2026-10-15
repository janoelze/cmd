// What a widget's grant lets it do, and how a verb is refused (docs/56, "Capabilities and
// grants"). What each verb and topic needs is protocol widget-verbs.ts's API row; the adapter
// (adapter.ts) checks it first. A press from a paired device: a view-scope device can't press
// at all (its trees carry no handlers), and an act asks on the Mac for a control-scope one,
// whatever was kept for always (remote/policy.ts, act.ts).

import type { ApiError, ApiVerb, WidgetPermissions } from "@cmd/protocol";

/** Whether a grant lets a widget ask for `verb` ("agents.start"): `act: ["agents"]` or `act: ["agents.start"]`. */
export const mayAct = (p: WidgetPermissions, verb: ApiVerb): boolean => p.act.includes(verb) || p.act.includes(verb.split(".")[0]!);

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

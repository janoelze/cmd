// Widgets reading the event log (docs/28 §4, scenario S6): a widget's data.ts
// talks to the core over its own socket (widgets.sock), says which widget it
// is with a token issued for that run, and may then query events, read-only,
// within the policy (policy.ts). Tokens are short-lived and single-run; the
// token says the widget, its workspace and the classes its manifest declares,
// which is all the policy needs: nothing the widget passes in a query widens it.

import { randomBytes } from "node:crypto";
import type { DataEvent, DataQuery } from "@cmd/protocol";
import { clampQuery, clampRows, type Reader } from "./policy.ts";

export interface WidgetIdentity {
  widgetId: string;
  workspaceId: string | null;
  /** Classes of data its manifest declares (permissions.events). */
  events: string[];
}

/** Most rows one query may return a widget. */
export const WIDGET_QUERY_LIMIT = 1000;

export class WidgetTokens {
  #tokens = new Map<string, WidgetIdentity & { expires: number }>();

  /** A token for one run of a widget's data.ts, good for `ttlMs`. */
  issue(id: WidgetIdentity, ttlMs = 60_000): string {
    this.#sweep();
    const token = randomBytes(24).toString("base64url");
    this.#tokens.set(token, { ...id, expires: Date.now() + ttlMs });
    return token;
  }

  /** The widget behind a token, or null for an unknown or expired one. */
  check(token: string): WidgetIdentity | null {
    const t = this.#tokens.get(token);
    if (!t) return null;
    if (t.expires < Date.now()) return this.#tokens.delete(token), null;
    return { widgetId: t.widgetId, workspaceId: t.workspaceId, events: t.events };
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, t] of this.#tokens) if (t.expires < now) this.#tokens.delete(k);
  }
}

const reader = (id: WidgetIdentity): Reader => ({ kind: "widget", workspaceId: id.workspaceId, declared: id.events });

/** A widget's query as the policy allows it: its workspace, the classes it may read, bounded. Throws PolicyError. */
export function widgetQuery(id: WidgetIdentity, q: DataQuery): DataQuery {
  return clampQuery(reader(id), q && typeof q === "object" ? q : {}, { fallback: 200, max: WIDGET_QUERY_LIMIT });
}

/** Runs a widget's query: clamped going in, its rows cut to what the widget may see coming out. */
export function widgetRead(id: WidgetIdentity, q: DataQuery, run: (q: DataQuery) => DataEvent[]): DataEvent[] {
  const clamped = widgetQuery(id, q);
  return clampRows(reader(id), clamped, run(clamped));
}

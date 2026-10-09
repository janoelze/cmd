// Widgets reading the event log (docs/28 §4, scenario S6): a widget's data.ts
// talks to the core over its own socket (widgets.sock), says which widget it
// is with a token issued for that run, and may then query events, read-only,
// within the policy here. Tokens are short-lived and single-run; the token
// says the widget and its workspace, which is all the policy needs.

import { randomBytes } from "node:crypto";
import type { DataQuery } from "@cmd/protocol";

export interface WidgetIdentity {
  widgetId: string;
  workspaceId: string | null;
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
    return { widgetId: t.widgetId, workspaceId: t.workspaceId };
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, t] of this.#tokens) if (t.expires < now) this.#tokens.delete(k);
  }
}

/** A widget's query as the policy allows it: bounded, never a cursor scan of everything. */
export function widgetQuery(q: DataQuery): DataQuery {
  return { ...q, limit: Math.min(q.limit ?? 200, WIDGET_QUERY_LIMIT) };
}

// Widgets reading the event log (docs/28 §4, scenario S6; docs/56): a widget's process
// talks to the core over its own socket (widgets.sock), says which widget it is with a
// token issued for it, and may then read events, read-only, within the policy (policy.ts):
// a package widget through the widget wire (widgets/api), anything else that says hello
// through data.query and stats.query. The token says the widget, its workspace and the
// classes it declared, which is all the policy needs: nothing it passes in a query widens it.

import { randomBytes } from "node:crypto";
import type { DataClass, DataEvent, DataQuery, StatQuery, StatResult } from "@cmd/protocol";
import { clampQuery, clampRows, PolicyError, readsClass, type Reader } from "./policy.ts";

export interface WidgetIdentity {
  widgetId: string;
  workspaceId: string | null;
  /** Classes of data it declares (permissions.events). */
  events: string[];
  /**
   * A package widget's process (widgets/host, docs/56): after hello its connection carries the
   * widget wire (widget-tree.ts) instead of JSON-RPC; this takes it over.
   */
  attach?: (send: (line: string) => void, close: () => void) => { receive(line: string): void; closed(): void };
}

/** Most rows one query may return a widget. */
export const WIDGET_QUERY_LIMIT = 1000;

export class WidgetTokens {
  #tokens = new Map<string, WidgetIdentity & { expires: number }>();

  /** A token for a widget's process, good for `ttlMs`. */
  issue(id: WidgetIdentity, ttlMs = 60_000): string {
    this.#sweep();
    const token = randomBytes(24).toString("base64url");
    this.#tokens.set(token, { ...id, expires: Date.now() + ttlMs });
    return token;
  }

  /** A run is over: its token stops working at once, not when it would have expired. */
  revoke(token: string): void {
    this.#tokens.delete(token);
  }

  /** The widget behind a token, or null for an unknown or expired one. */
  check(token: string): WidgetIdentity | null {
    const t = this.#tokens.get(token);
    if (!t) return null;
    if (t.expires < Date.now()) return this.#tokens.delete(token), null;
    return { widgetId: t.widgetId, workspaceId: t.workspaceId, events: t.events, ...(t.attach ? { attach: t.attach } : {}) };
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

/**
 * A widget's stat (docs/49): only of a class it may read, only its own
 * workspace (whatever the query names), and its rankings no longer than a query's limit.
 */
export function widgetStats(id: WidgetIdentity, q: StatQuery, classOf: (stat: string) => DataClass, run: (q: StatQuery) => StatResult): StatResult {
  if (!q || typeof q !== "object" || typeof q.stat !== "string") throw new PolicyError("stats(): name a stat ({ stat: \"commands.runs\" })");
  const c = classOf(q.stat);
  if (!readsClass(reader(id), c)) throw new PolicyError(`stats(): "${q.stat}" is ${c} data: add "${c}" to permissions.events in the manifest`);
  const { workspaceId: _ignored, ...rest } = q;
  return run({ ...rest, ...(id.workspaceId ? { workspaceId: id.workspaceId } : {}), ...(q.top ? { top: Math.min(q.top, 50) } : {}) });
}

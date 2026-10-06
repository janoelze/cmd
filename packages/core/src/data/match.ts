// Whether an event answers a query (docs/28 §4): the same filters the store
// turns into SQL, applied to one event in memory, so a subscription can be
// told about a new event without running its query again. Full text is the
// one filter that needs the index: the caller supplies that check.

import type { DataEvent, DataQuery } from "@cmd/protocol";

export function matchesQuery(q: DataQuery, e: DataEvent, text?: (seq: number, expression: string) => boolean): boolean {
  if (q.types?.length && !q.types.some((t) => (t.endsWith(".") ? e.type.startsWith(t) : e.type === t))) return false;
  if (q.at && (e.at < q.at[0] || e.at >= q.at[1])) return false;
  if (q.spaceId && e.spaceId !== q.spaceId) return false;
  if (q.projectId && e.projectId !== q.projectId) return false;
  if (q.sessionId && e.sessionId !== q.sessionId) return false;
  if (q.agentId && e.agentId !== q.agentId) return false;
  if (q.paneId && e.paneId !== q.paneId) return false;
  if (q.windowId && e.windowId !== q.windowId) return false;
  if (q.parentId && e.parentId !== q.parentId) return false;
  if (q.after && e.seq <= q.after) return false;
  if (q.text) return text ? text(e.seq, q.text) : false;
  return true;
}

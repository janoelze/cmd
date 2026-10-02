// Sidebar ordering, shared so UI, CLI and Dock badge agree. See docs/07-ui-vision.md.

import type { Agent, Pane } from "./model.ts";

export type Bucket = "needs" | "unseen" | "rest";

export function bucketOf(agent: Agent | null): Bucket {
  if (!agent) return "rest";
  if (agent.state === "needs_input") return "needs";
  if (agent.state === "done" && (agent.seenAt ?? 0) < agent.stateSince) return "unseen";
  return "rest";
}

export function needsAttention(agent: Agent): boolean {
  return bucketOf(agent) !== "rest";
}

export interface Row {
  pane: Pane;
  agent: Agent | null;
}

const ORDER: Record<Bucket, number> = { needs: 0, unseen: 1, rest: 2 };

/**
 * needs-input first (longest wait first, so nothing starves),
 * then done-but-unseen (oldest first), then everything else by recency.
 */
export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const ba = bucketOf(a.agent);
    const bb = bucketOf(b.agent);
    if (ba !== bb) return ORDER[ba] - ORDER[bb];
    if (ba === "rest") return activity(b) - activity(a);
    return a.agent!.stateSince - b.agent!.stateSince;
  });
}

function activity(r: Row): number {
  return Math.max(r.pane.lastActivityAt, r.agent?.stateSince ?? 0);
}

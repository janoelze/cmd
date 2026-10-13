// The Operator in the renderer (docs/51): each workspace's conversation as the core keeps it,
// kept current by operator.changed, and the board's marks: the window a step is acting on, for
// as long as it acts and a moment after, so the title bar can say so (TileTitle).

import { useEffect, useSyncExternalStore } from "react";
import type { OperatorConversation, OperatorItem, WindowId, WorkspaceId } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";

const convs = new Map<WorkspaceId, OperatorConversation>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));

/** What a step acting on a window says on its title bar. */
export interface OperatorMark {
  why: string;
  waiting: boolean;
}
const marks = new Map<WindowId, OperatorMark & { item: string }>();
const linger = new Map<string, ReturnType<typeof setTimeout>>();
/** How long a mark stays after its step ended, so a quick one is still seen. */
const LINGER_MS = 1500;

function mark(item: OperatorItem): void {
  if (item.kind !== "tool" || !item.acts || !item.target) return;
  const target = item.target;
  clearTimeout(linger.get(item.id));
  if (item.state === "running" || item.state === "waiting") {
    marks.set(target, { item: item.id, why: item.why, waiting: item.state === "waiting" });
    return;
  }
  linger.set(
    item.id,
    setTimeout(() => {
      linger.delete(item.id);
      if (marks.get(target)?.item === item.id) marks.delete(target), changed();
    }, LINGER_MS),
  );
}

cmd.onEvent((e) => {
  if (e.type !== "operator.changed") return;
  for (const item of e.items ?? []) mark(item);
  const c = convs.get(e.workspaceId);
  if (c) {
    let items = e.reset ? [] : c.items;
    for (const item of e.items ?? []) {
      const i = items.findIndex((x) => x.id === item.id);
      items = i >= 0 ? items.map((x, j) => (j === i ? item : x)) : [...items, item];
    }
    convs.set(e.workspaceId, {
      ...c,
      items,
      ...(e.busy !== undefined ? { busy: e.busy } : {}),
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(e.usage ? { usage: e.usage } : {}),
      ...(e.model !== undefined ? { model: e.model } : {}),
      ...(e.latency !== undefined ? { latency: e.latency } : {}),
    });
  }
  changed();
});

// A new core (a restart) knows the conversations from its database: ask again.
cmd.onStatus((s) => {
  if (s !== "connected") return;
  for (const id of convs.keys()) void load(id);
});

async function load(workspaceId: WorkspaceId): Promise<void> {
  try {
    convs.set(workspaceId, await cmd.call("operator.get", { workspaceId }));
    changed();
  } catch {
    // an older core without the Operator: the view says so
  }
}

/** A workspace's conversation, null until the core answered. */
export function useOperator(workspaceId: WorkspaceId): OperatorConversation | null {
  useEffect(() => {
    if (!convs.has(workspaceId)) void load(workspaceId);
  }, [workspaceId]);
  return useSyncExternalStore(subscribe, () => convs.get(workspaceId) ?? null);
}

/** What the Operator is doing to this window right now, if anything. */
export function useOperatorMark(id: WindowId | null | undefined): OperatorMark | null {
  return useSyncExternalStore(subscribe, () => (id ? (marks.get(id) ?? null) : null));
}

export const operatorCall = {
  send: (workspaceId: WorkspaceId, text: string, selected: WindowId | null) => cmd.call("operator.send", { workspaceId, text, selected }),
  stop: (workspaceId: WorkspaceId) => cmd.call("operator.stop", { workspaceId }),
  answer: (workspaceId: WorkspaceId, itemId: string, allow: boolean, reason?: string, remember?: boolean) => cmd.call("approvals.answer", { workspaceId, itemId, allow, reason, remember }),
  reset: (workspaceId: WorkspaceId) => cmd.call("operator.reset", { workspaceId }),
  open: (workspaceId: WorkspaceId, id: string) => cmd.call("operator.open", { workspaceId, id }),
};

// The board's marks for tool calls (docs/54): a window an agent or a widget's model acts on lights up
// and its title bar says who and why, for as long as the call runs and a moment after; a call
// waiting for the person marks the window it would act on (else the caller's own) and can be
// answered there (TileTitle → ActingApproval). From tool.acting; the waiting ones again after a
// reconnect (approvals.waiting).

import { useSyncExternalStore } from "react";
import type { ToolActivity, WindowId } from "@cmd/protocol";
import { cmd } from "./bridge.ts";

/** What a call acting on a window says on its title bar. */
export interface ActingMark {
  call: ToolActivity;
  waiting: boolean;
}

const marks = new Map<WindowId, ActingMark>();
const linger = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
/** How long a mark stays after its call ended, so a quick one is still seen. */
const LINGER_MS = 1500;

/** The window a call is shown on. */
const windowOf = (a: ToolActivity) => a.target ?? (a.state === "waiting" ? a.callerWindowId : null);

function show(a: ToolActivity): void {
  clearTimeout(linger.get(a.id));
  // A call that waited on the caller's window and now runs on its target leaves the first.
  for (const [w, m] of marks) if (m.call.id === a.id && w !== windowOf(a)) marks.delete(w);
  const target = windowOf(a);
  if (!target) return changed();
  if (a.state === "running" || a.state === "waiting") {
    marks.set(target, { call: a, waiting: a.state === "waiting" });
    return changed();
  }
  if (marks.get(target)?.call.id === a.id) marks.set(target, { call: a, waiting: false });
  linger.set(
    a.id,
    setTimeout(() => {
      linger.delete(a.id);
      if (marks.get(target)?.call.id === a.id) marks.delete(target), changed();
    }, LINGER_MS),
  );
  changed();
}

cmd.onEvent((e) => e.type === "tool.acting" && show(e.call));

// A new core knows nothing of what the old one marked; what waits now is asked again.
cmd.onStatus((s) => {
  if (s !== "connected") return;
  marks.clear();
  changed();
  void cmd.call("approvals.waiting", {}).then((all) => all.forEach(show), () => {});
});

/** What a tool call is doing to this window right now, if anything. */
export function useActingMark(id: WindowId | null | undefined): ActingMark | null {
  return useSyncExternalStore(subscribe, () => (id ? (marks.get(id) ?? null) : null));
}

/** Answer a call waiting for the person. */
export const answerCall = (a: ToolActivity, allow: boolean, reason?: string, remember?: boolean) => cmd.call("approvals.answer", { workspaceId: a.workspaceId, itemId: a.id, allow, reason, remember });

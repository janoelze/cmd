// Tool calls waiting for the person (docs/55), oldest first: one queue for the approval sheet
// (shell/Approvals.tsx), whoever asks (an agent's tool call, the Operator). From tool.acting;
// a new core's waiting calls again after it connects (approvals.waiting).

import { useSyncExternalStore } from "react";
import type { ToolActivity } from "@cmd/protocol";
import { cmd } from "./bridge.ts";

let queue: ToolActivity[] = [];
const listeners = new Set<() => void>();
const set = (next: ToolActivity[]) => ((queue = next), listeners.forEach((fn) => fn()));

cmd.onEvent((e) => {
  if (e.type !== "tool.acting") return;
  const a = e.call;
  const at = queue.findIndex((x) => x.id === a.id);
  if (a.state === "waiting" && a.approval) set(at >= 0 ? queue.map((x, i) => (i === at ? a : x)) : [...queue, a]);
  else if (at >= 0) set(queue.filter((x) => x.id !== a.id));
});

cmd.onStatus((s) => {
  if (s !== "connected") return;
  void cmd.call("approvals.waiting", {}).then((all) => set(all.filter((a) => a.approval)), () => set([]));
});

/** The calls waiting for the person, oldest first. */
export function useAsks(): readonly ToolActivity[] {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => queue,
  );
}

/** Answer one; it leaves the queue at once (the core confirms with tool.acting). */
export function answerAsk(a: ToolActivity, allow: boolean, o: { scope?: "once" | "session" | "always"; reason?: string } = {}): Promise<null> {
  set(queue.filter((x) => x.id !== a.id));
  return cmd.call("approvals.answer", { workspaceId: a.workspaceId, itemId: a.id, allow, ...o });
}

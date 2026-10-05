// The core's AI status (docs/17-ai.md) in any window: which providers have a
// key, whether it works, what each tier uses. Asked for on every connect and
// kept current by ai.updated (a window must subscribe to it; the app window
// gets every event, the Settings window asks for it).

import { useSyncExternalStore } from "react";
import type { AiStatus } from "@cmd/protocol";
import { cmd } from "../bridge.ts";

let status: AiStatus | null = null;
const listeners = new Set<() => void>();
const set = (s: AiStatus) => ((status = s), listeners.forEach((fn) => fn()));

cmd.onEvent((e) => e.type === "ai.updated" && set(e.status));
cmd.onStatus((s) => {
  if (s === "connected") cmd.call("ai.status", {}).then(set, () => {}); // a core older than the app has none
});

/** null until the core has answered. */
export function useAiStatus(): AiStatus | null {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => status,
  );
}

export const aiStatus = (): AiStatus | null => status;

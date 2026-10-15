// The kernel's own methods: the core's processes, usage stats, settings, secrets and the UI's
// state (core.hello, core.info and events.subscribe are Core's, in core.ts).

import type { ProcessStat } from "@cmd/protocol";
import type { CoreContext } from "./context.ts";
import { slice } from "./handlers.ts";

/** core.processes answers from one sample this long: every window's footer asks, and CPU% is since the last sample. */
export const PROCESSES_FRESH_MS = 4000;

export const kernelHandlers = (core: CoreContext) => {
  let last: { at: number; value: Promise<{ core: ProcessStat | null; ptyHost: ProcessStat | null }> } | null = null;
  return slice({
    "core.processes": () => {
      if (last && Date.now() - last.at < PROCESSES_FRESH_MS) return last.value;
      const host = core.panes.backend.info?.()?.pid ?? null;
      const value = (async () => {
        const stats = (await core.processes?.sample(host ? [process.pid, host] : [process.pid])) ?? new Map();
        return { core: stats.get(process.pid) ?? null, ptyHost: host ? (stats.get(host) ?? null) : null };
      })();
      last = { at: Date.now(), value };
      return value;
    },
    "usage.launch": () => (core.usage.launch(), null),
    "settings.get": () => core.settings.snapshot(),
    "settings.set": (p) => core.settings.set(p.key, p.value),
    "settings.reset": (p) => core.settings.reset(p.key),
    "secrets.status": () => core.secrets.status(),
    "secrets.set": (p) => core.secrets.set(p.key, p.value),
    "ui.get": () => core.store.uiState(),
    "app.attach": (p) => (core.processes?.attach(Number(p?.pid)), null),
    "ui.set": (p) => {
      if (typeof p.key !== "string" || !p.key || p.key.length > 200) throw new Error("ui.set: invalid key");
      if (JSON.stringify(p.value ?? null).length > 64 * 1024) throw new Error("ui.set: value too large");
      core.store.setUiState(p.key, p.value);
      return null;
    },
  });
};

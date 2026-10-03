// The Settings window's view of the core: the settings snapshot, kept current
// through a subscription to settings.updated only (not the app's full store).

import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, type SettingsSnapshot } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { applyThemeSettings } from "../themes/registry.ts";

let snapshot: SettingsSnapshot = { settings: DEFAULT_SETTINGS, overrides: [], errors: [], path: "" };
let connected = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

cmd.onEvent((e) => {
  if (e.type !== "settings.updated") return;
  snapshot = e.snapshot;
  applyThemeSettings(snapshot.settings);
  emit();
});
cmd.onStatus(async (status) => {
  connected = status === "connected";
  if (connected) {
    try {
      snapshot = (await cmd.call("events.subscribe", { types: ["settings.updated"] })).settings;
      applyThemeSettings(snapshot.settings);
    } catch {
      connected = false;
    }
  }
  emit();
});

const state = () => ({ snapshot, connected });
let last = state();

export function useSettings(): { snapshot: SettingsSnapshot; connected: boolean } {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => (last.snapshot === snapshot && last.connected === connected ? last : (last = state())),
  );
}

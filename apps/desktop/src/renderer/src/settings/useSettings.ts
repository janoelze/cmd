// The Settings window's view of the core: the settings snapshot, which secrets
// (API keys) are set, and the transcript index status, kept current through a
// subscription to just those events (not the app's full store).

import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, type SearchStatus, type SecretsStatus, type SettingsSnapshot } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { applyThemeSettings } from "../themes/registry.ts";

let snapshot: SettingsSnapshot = { settings: DEFAULT_SETTINGS, overrides: [], errors: [], path: "" };
let search: SearchStatus | null = null;
let secrets: SecretsStatus | null = null;
let connected = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

cmd.onEvent((e) => {
  if (e.type === "search.status") search = e.status;
  else if (e.type === "secrets.updated") secrets = e.status;
  else if (e.type === "settings.updated") {
    snapshot = e.snapshot;
    applyThemeSettings(snapshot.settings);
  } else return;
  emit();
});
cmd.onStatus(async (status) => {
  connected = status === "connected";
  if (connected) {
    try {
      snapshot = (await cmd.call("events.subscribe", { types: ["settings.updated", "search.status", "secrets.updated"] })).settings;
      applyThemeSettings(snapshot.settings);
      search = await cmd.call("search.status", {});
      secrets = await cmd.call("secrets.status", {});
    } catch {
      connected = false;
    }
  }
  emit();
});

const state = () => ({ snapshot, connected, search, secrets });
let last = state();

export function useSettings(): { snapshot: SettingsSnapshot; connected: boolean; search: SearchStatus | null; secrets: SecretsStatus | null } {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => (last.snapshot === snapshot && last.connected === connected && last.search === search && last.secrets === secrets ? last : (last = state())),
  );
}

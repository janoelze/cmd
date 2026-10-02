// Current shortcuts (defaults + keybindings.json), mirrored from the main process
// for palette hints and the settings panel.

import { useSyncExternalStore } from "react";
import { DEFAULT_KEYBINDINGS } from "../../shared/commands.ts";
import type { KeybindingsSnapshot } from "../../main/keybindings.ts";
import { cmd } from "./bridge.ts";

let snapshot: KeybindingsSnapshot = { bindings: DEFAULT_KEYBINDINGS, errors: [], path: "" };
const listeners = new Set<() => void>();
const set = (s: KeybindingsSnapshot) => {
  snapshot = s;
  for (const fn of listeners) fn();
};
void cmd.keybindings().then(set);
cmd.onKeybindings(set);

export function useKeybindings(): KeybindingsSnapshot {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => snapshot,
  );
}

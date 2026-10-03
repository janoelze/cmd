// Current shortcuts (defaults + keybindings.json), mirrored from the main process
// for palette hints and the settings panel.

import { useSyncExternalStore } from "react";
import { DEFAULT_KEYBINDINGS, norm } from "../../shared/commands.ts";
import type { KeybindingsSnapshot } from "../../main/keybindings.ts";
import { cmd } from "./bridge.ts";

let snapshot: KeybindingsSnapshot = { bindings: DEFAULT_KEYBINDINGS, errors: [], path: "" };
const listeners = new Set<() => void>();
let bound = boundSet(snapshot);
const set = (s: KeybindingsSnapshot) => {
  snapshot = s;
  bound = boundSet(s);
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

function boundSet(s: KeybindingsSnapshot): Set<string> {
  return new Set(Object.values(s.bindings).flat().map(norm));
}

/** The key of a KeyboardEvent as an accelerator key ("k", "1", "]", "right"), layout-independent. */
function eventKey(e: KeyboardEvent): string {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  const named: Record<string, string> = { Comma: ",", Period: ".", Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Tab: "tab", Enter: "enter", Escape: "escape", Space: "space", Backspace: "backspace" };
  return named[c] ?? e.key.toLowerCase();
}

/** Outside macOS: is this key event one of the app's shortcuts (so the terminal must not take it)? */
export function isAppShortcut(e: KeyboardEvent): boolean {
  if (!e.ctrlKey && !e.altKey) return false;
  const mods = [e.altKey && "alt", e.ctrlKey && "ctrl", e.metaKey && "cmd", e.shiftKey && "shift"].filter(Boolean).sort();
  return bound.has([...mods, eventKey(e)].join("+"));
}

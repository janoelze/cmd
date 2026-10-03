// Current shortcuts (defaults + keybindings.json), mirrored from the main process
// for palette hints and the settings panel.

import { useSyncExternalStore } from "react";
import { DEFAULT_KEYBINDINGS, MAC_KEYMAP, norm } from "../../shared/commands.ts";
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

const ACCELERATOR_KEYS: Record<string, string> = { Comma: ",", Period: ".", Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Tab: "Tab", Enter: "Enter", NumpadEnter: "Enter", Escape: "Escape", Space: "Space", Backspace: "Backspace", Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };

/**
 * A key event as a shortcut for keybindings.json ("Shift+Cmd+K"), layout-independent;
 * null for a lone modifier or a key it can't name. Modifiers in the defaults' order.
 */
export function acceleratorOf(e: KeyboardEvent, mac = MAC_KEYMAP): string | null {
  const c = e.code;
  const key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c : ACCELERATOR_KEYS[c];
  if (!key || (e.metaKey && !mac)) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Cmd"].filter((m): m is string => !!m);
  return [...mods, key].join("+");
}

/** A shortcut that can't be typed into a terminal or field: it has ⌘/Ctrl/Alt, or is a function key. */
export const usableShortcut = (acc: string) => /^F\d/.test(acc.split("+").pop()!) || /(^|\+)(Cmd|Ctrl|Alt)\+/.test(acc);

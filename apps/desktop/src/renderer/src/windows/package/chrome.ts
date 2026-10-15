// A package widget's window chrome (docs/56, "Writing the UI"): what its tree's `Window`
// says for the title bar, kept per window so the registry's titleMenu, menu and actions
// (register.tsx) can read it when the title bar draws or a menu opens. The status line
// goes through setWindowStatus like every built-in widget's; the menus live here.

import { isHandler, type WireMenuEntry, type WireValue, type WindowId } from "@cmd/protocol";
import type { MenuEntry } from "../../lib/context.ts";
import { windowChromeChanged } from "../registry.ts";

/** Sends an interaction to the widget's process. */
export type Send = (handler: number, event: string, value?: WireValue) => void;

export interface Chrome {
  /** The title menu (Window menu). */
  menu: WireMenuEntry[] | null;
  /** The title menu's button (Window menuLabel, 1.3); null: the checked entry's label. */
  menuLabel: string | null;
  /** Entries first in the context menu (Window actions). */
  actions: WireMenuEntry[] | null;
  send: Send;
}

const chrome = new Map<WindowId, Chrome>();

export function setChrome(id: WindowId, c: Chrome | null): void {
  if (c) chrome.set(id, c);
  else if (!chrome.delete(id)) return;
  windowChromeChanged();
}

export function chromeOf(id: WindowId): Chrome | undefined {
  return chrome.get(id);
}

/** A menu from the wire as the app's menus take it: each `run` sends the interaction. */
export function menuEntries(entries: readonly WireMenuEntry[] | null | undefined, send: Send): MenuEntry[] {
  return (entries ?? []).map((e): MenuEntry => {
    if ("separator" in e) return "-";
    if (e.submenu) return { label: e.label, enabled: !e.disabled, submenu: menuEntries(e.submenu, send) };
    const run = e.run;
    return { label: e.label, checked: e.checked, enabled: !e.disabled && isHandler(run), run: () => isHandler(run) && send(run.$handler, "run") };
  });
}

/** The title menu's label: the chosen entry ("This Workspace"), as built-in widgets' menus say it. */
export function menuLabel(entries: readonly WireMenuEntry[] | null | undefined): string {
  const checked = (entries ?? []).find((e) => !("separator" in e) && e.checked);
  return checked && !("separator" in checked) ? checked.label : "Options";
}

// Per-window actions and status shared between a window's content and the app:
//  - actions: commands route here (⌘S → the focused text window's save)
//  - status: what a window wants shown in its title bar / the status bar
//    (e.g. "Edited", "682 lines · 17 KB"), set by the content component.

import { useSyncExternalStore } from "react";

type Actions = { save?: () => void | Promise<void>; openExternally?: () => void; change?: () => void };
const registry = new Map<string, Actions>();

export function registerWindowActions(id: string, actions: Actions): () => void {
  registry.set(id, actions);
  return () => {
    if (registry.get(id) === actions) registry.delete(id);
  };
}

export function windowActions(id: string | null): Actions | undefined {
  return id ? registry.get(id) : undefined;
}

export interface WindowStatus {
  /** Short text for the title bar / status bar. */
  label: string;
  /** Which state this is ("edited", "info", …). A new label with the same key
   *  updates in place; a new key animates (see components/Slot.tsx). Defaults to the label. */
  key?: string;
  /** A brief state (loading): shown only if it lasts, so fast changes don't flash. */
  transient?: boolean;
  /** Unsaved changes. */
  dirty?: boolean;
}

let statuses = new Map<string, WindowStatus>();
const listeners = new Set<() => void>();

export function setWindowStatus(id: string, status: WindowStatus | null): void {
  const cur = statuses.get(id);
  const same = (a: WindowStatus, b: WindowStatus) =>
    a.label === b.label && a.key === b.key && a.transient === b.transient && a.dirty === b.dirty;
  if (status ? cur && same(cur, status) : !cur) return;
  statuses = new Map(statuses);
  if (status) statuses.set(id, status);
  else statuses.delete(id);
  for (const fn of listeners) fn();
}

export function useWindowStatus(id: string | null): WindowStatus | undefined {
  const map = useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => statuses,
  );
  return id ? map.get(id) : undefined;
}

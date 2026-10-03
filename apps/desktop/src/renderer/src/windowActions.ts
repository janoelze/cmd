// Per-window actions and status shared between a window's content and the app:
//  - actions: commands route here (⌘S → the focused text window's save)
//  - status: what a window wants shown in its title bar / the status bar
//    (e.g. "Edited", "682 lines · 17 KB"), set by the content component.

import { useSyncExternalStore } from "react";

type Actions = { save?: () => void | Promise<void>; openExternally?: () => void };
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
  /** Unsaved changes. */
  dirty?: boolean;
}

let statuses = new Map<string, WindowStatus>();
const listeners = new Set<() => void>();

export function setWindowStatus(id: string, status: WindowStatus | null): void {
  const cur = statuses.get(id);
  if (status ? cur?.label === status.label && cur?.dirty === status.dirty : !cur) return;
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

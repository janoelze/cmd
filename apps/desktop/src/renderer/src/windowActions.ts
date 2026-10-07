// Per-window actions and status shared between a window's content and the app:
//  - actions: commands route here (⌘S → the focused text window's save)
//  - status: what a window wants shown in its title bar / the status bar
//    (e.g. "Edited", "682 lines · 17 KB"), set by the content component.
//  - title edits: the title bar as an input for a moment (Magic widgets' Change)

import { useSyncExternalStore } from "react";
import type { FindRequest } from "./find.tsx";

type Actions = {
  save?: () => void | Promise<void>;
  openExternally?: () => void;
  /** Magic widgets: change (refine), refresh the data, stop a run. */
  change?: () => void;
  refresh?: () => void;
  stop?: () => void;
  /** ⌘E: a window's other face (Markdown preview / source, a Magic widget's edit view). */
  toggleEdit?: () => void;
  /** ⌘F / ⌘G / ⇧⌘G / ⌥⌘F, Use Selection for Find (find.tsx). */
  find?: (r: FindRequest) => void;
  /** ⌘+ / ⌘− / ⌘0 zoom the window's content (a PDF) instead of the app's text. */
  zoom?: (d: 1 | -1 | 0) => void;
};
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
  /** Clicking the status in the title bar does this ("Updated 12s ago" → refresh). */
  action?: { run: () => void; title: string };
}

let statuses = new Map<string, WindowStatus>();
const listeners = new Set<() => void>();

export function setWindowStatus(id: string, status: WindowStatus | null): void {
  const cur = statuses.get(id);
  const same = (a: WindowStatus, b: WindowStatus) =>
    a.label === b.label && a.key === b.key && a.transient === b.transient && a.dirty === b.dirty && a.action?.title === b.action?.title;
  if (status ? cur && same(cur, status) : !cur) return;
  statuses = new Map(statuses);
  if (status) statuses.set(id, status);
  else statuses.delete(id);
  for (const fn of listeners) fn();
}

export function windowStatus(id: string): WindowStatus | undefined {
  return statuses.get(id);
}

export function useWindowStatus(id: string | null): WindowStatus | undefined {
  const map = useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => statuses,
  );
  return id ? map.get(id) : undefined;
}

/**
 * A window's title bar turned into an input, in place of its name (a Magic
 * window's Change, ⌘L): what it asks, and what ⏎ does with the text.
 */
export interface TitleEdit {
  placeholder: string;
  submit: (text: string) => void;
}

let edits = new Map<string, TitleEdit>();
const editListeners = new Set<() => void>();

export function editTitle(id: string, edit: TitleEdit | null): void {
  if (!edit && !edits.has(id)) return;
  edits = new Map(edits);
  if (edit) edits.set(id, edit);
  else edits.delete(id);
  for (const fn of editListeners) fn();
}

export function useTitleEdit(id: string | null): TitleEdit | undefined {
  const map = useSyncExternalStore(
    (fn) => (editListeners.add(fn), () => editListeners.delete(fn)),
    () => edits,
  );
  return id ? map.get(id) : undefined;
}

// Who listens for the core's events that aren't state: notifications, files and Workspace
// Actions that changed, windows to bring forward. lib/store.ts calls them as the events come
// and exports the on… functions.

import type { AppNotification, WindowId } from "@cmd/protocol";

export const focusListeners = new Set<(id: WindowId) => void>();
export const fsListeners = new Set<(path: string) => void>();
export const actionsListeners = new Set<(root: string) => void>();
export const notificationListeners = new Set<(n: AppNotification) => void>();

/** A notification from the core (packages/core/src/notifications/center.ts); the UI decides whether to show it. */
export function onNotification(fn: (n: AppNotification) => void): () => void {
  notificationListeners.add(fn);
  return () => notificationListeners.delete(fn);
}

/** A watched file or folder changed on disk (see fs.watch). */
export function onFsChanged(fn: (path: string) => void): () => void {
  fsListeners.add(fn);
  return () => fsListeners.delete(fn);
}

/** A folder's Workspace Actions changed (actions.list again). */
export function onActionsChanged(fn: (root: string) => void): () => void {
  actionsListeners.add(fn);
  return () => actionsListeners.delete(fn);
}

/** The core asks to bring a window forward (e.g. `open .` in a terminal). */
export function onWindowFocus(fn: (id: WindowId) => void): () => void {
  focusListeners.add(fn);
  return () => focusListeners.delete(fn);
}

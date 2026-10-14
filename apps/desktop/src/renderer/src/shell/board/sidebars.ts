// Sidebars coming and going (docs/21-sidebars.md): View → Show Left/Right Sidebar slides a
// side out (its window kept until it is out of sight) or in, Show Sidebars both at once;
// an empty left side gets a Navigator, and so does every workspace at first (also the
// migration from the old sidebar).

import { useEffect, useSyncExternalStore } from "react";
import { GLIDE_MS, reducedMotion } from "@cmd/ui";
import type { WorkspaceId } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { windowIdOf, type SidebarRow } from "../../lib/model.ts";
import { getState, getWorkspaceView, setWorkspaceView } from "../../lib/store.ts";
import { boardOf } from "./board.ts";
import { dock, dockWidths, readDocks, SIDES, type Docks, type Side } from "./docks.ts";
import { setDocks } from "./view.ts";

export type Slide = { dir: "in" | "out"; row?: SidebarRow; width?: number };

let sliding: Partial<Record<Side, Slide>> = {};
const listeners = new Set<() => void>();
const timers: Partial<Record<Side, ReturnType<typeof setTimeout>>> = {};
const set = (next: Partial<Record<Side, Slide>>) => ((sliding = next), listeners.forEach((fn) => fn()));

export function useSliding(): Partial<Record<Side, Slide>> {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => sliding,
  );
}

/** Hide or show a side; an empty left side gets a Navigator. */
export function toggleSide(side: Side): void {
  const board = boardOf(getState());
  const d = board.docks;
  const id = d[side].id;
  if (!id) {
    if (side === "left") void openNavigator(board.workspaceId, "left");
    return;
  }
  const row = board.allFlat.find((r) => windowIdOf(r) === id);
  // It slides out (kept until it's gone) or in.
  if (row && !d[side].hidden) set({ ...sliding, [side]: { dir: "out", row, width: dockWidths(d, window.innerWidth)[side] } });
  else set({ ...sliding, [side]: { dir: "in" } });
  clearTimeout(timers[side]);
  timers[side] = setTimeout(() => set(Object.fromEntries(Object.entries(sliding).filter(([k]) => k !== side))), reducedMotion() ? 0 : GLIDE_MS);
  setDocks((x) => ({ ...x, [side]: { ...x[side], hidden: !x[side].hidden } }));
}

export const anySideShown = (d: Docks): boolean => SIDES.some((s) => !!d[s].id && !d[s].hidden);

/**
 * Show Sidebars (View menu, the top bar): hides every shown side, or shows again the
 * ones it hid (kept per workspace in "sidebars.hid"); with none to bring back, every
 * docked side, or a Navigator on the left.
 */
export function toggleSidebars(): void {
  const { docks: d, workspaceId } = boardOf(getState());
  const shown = SIDES.filter((s) => d[s].id && !d[s].hidden);
  if (shown.length) {
    setWorkspaceView(workspaceId, "sidebars.hid", shown);
    shown.forEach(toggleSide);
    return;
  }
  const hid = getWorkspaceView<unknown>(workspaceId, "sidebars.hid", []);
  const back = SIDES.filter((s) => d[s].id && Array.isArray(hid) && hid.includes(s));
  const sides = back.length ? back : SIDES.filter((s) => d[s].id);
  (sides.length ? sides : (["left"] as const)).forEach(toggleSide);
}

/** A Navigator docked to `side` of a workspace; `carry` is the side's earlier width and visibility. */
export async function openNavigator(workspaceId: WorkspaceId, side: Side, carry?: { hidden: boolean; width: number | null }): Promise<void> {
  const w = await cmd.call("window.open", { kind: "navigator", workspaceId });
  const d = readDocks(getWorkspaceView(workspaceId, "docks", null));
  const next = dock(d, w.id, side);
  setWorkspaceView(workspaceId, "docks", carry ? { ...next, [side]: { ...next[side], ...carry } } : next);
}

/** Workspaces being given their first Navigator, so a re-render doesn't make two. */
const making = new Set<WorkspaceId>();

/**
 * Every workspace starts with a Navigator docked left, which is also the migration
 * from the old sidebar (its width and whether it was shown carry over). Once
 * a workspace has sidebars (even none), it's left alone.
 */
export function useFirstNavigator(workspaceId: WorkspaceId, ready: boolean, unset: boolean, carry: { hidden: boolean; width: number | null }): void {
  useEffect(() => {
    if (!ready || !unset || making.has(workspaceId)) return;
    making.add(workspaceId);
    openNavigator(workspaceId, "left", carry).catch(() => {
      // An older core without the Navigator type: no sidebars rather than asking again.
      setWorkspaceView(workspaceId, "docks", {});
    });
  }, [workspaceId, ready, unset]); // eslint-disable-line react-hooks/exhaustive-deps
}

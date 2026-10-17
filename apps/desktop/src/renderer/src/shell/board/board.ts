// The shown workspace as the board lays it out: its rows (the Navigator's), those on the board
// (not in a sidebar), the windows in view order, its sidebars and the layout keys of its view.
// Pure, from the store's state, and computed once per state: the app and every command read it.

import type { PaneId, WorkspaceId } from "@cmd/protocol";
import { arrangeTiles, buildRows, flatten, inWorkspace, windowIdOf, type SidebarRow } from "../../lib/model.ts";
import type { State } from "../../lib/store.ts";
import { DEFAULT_CAMERA, type Camera } from "./canvas.ts";
import { dockedIds, liveDocks, readDocks, type Docks } from "./docks.ts";
import type { Rect, ViewMode } from "./layouts.ts";

export interface Board {
  /** What this app window shows: its workspace's terminals, agents and windows. */
  shown: State;
  workspaceId: WorkspaceId;
  mode: ViewMode;
  /** The layout Toggle Focus returns to. */
  layoutMode: ViewMode;
  gridOrder: PaneId[];
  stripWidths: Record<PaneId, number>;
  canvasRects: Record<PaneId, Rect>;
  camera: Camera;
  /** Its sidebars as stored (null: the workspace has none yet, see useFirstNavigator) and as live. */
  storedDocks: Docks | null;
  docks: Docks;
  /** Every row of the workspace (the Navigator's), and those on the board: not in a sidebar. */
  allRows: SidebarRow[];
  rows: SidebarRow[];
  flat: SidebarRow[];
  allFlat: SidebarRow[];
  /** Rows with a window (terminal, browser, files…), sidebar order. */
  windows: SidebarRow[];
  /** The board's windows in the order the view shows them (the board's order; on the canvas the sidebar's). */
  order: PaneId[];
  /** The board's windows in grid order, whatever the view (where a closed one was, reopen.ts). */
  boardOrder: PaneId[];
}

const view = <T,>(s: State, key: string, fallback: T): T => {
  const v = s.workspaces.get(s.workspaceId)?.view[key];
  return v === undefined ? fallback : (v as T);
};

const cache = new WeakMap<State, Board>();

export function boardOf(all: State): Board {
  const hit = cache.get(all);
  if (hit) return hit;
  const shown = inWorkspace(all);
  const mode = view<ViewMode>(all, "view.mode", all.settings.settings["ui.defaultView"]);
  const gridOrder = view<PaneId[]>(all, "grid.order", []);
  const storedDocks = view<Docks | null>(all, "docks", null);
  const docks = liveDocks(readDocks(storedDocks), (id) => shown.panes.has(id) || shown.windows.has(id));
  const docked = dockedIds(docks);
  const allRows = buildRows(shown);
  // A workspace's first Navigator is docked once its window.open returns, which can be a
  // render after the window itself arrives: until the workspace has sidebars, a Navigator
  // isn't a board window (it would show full size for a frame, then jump left).
  const rows = allRows.filter((r) => !docked.has(windowIdOf(r) ?? "") && !(storedDocks === null && r.win?.kind === "navigator"));
  const flat = flatten(rows);
  const windows = flat.filter((r) => r.pane || r.win);
  const wins = windows.map((r) => ({ id: windowIdOf(r)!, createdAt: r.pane?.createdAt ?? r.win?.createdAt ?? 0 }));
  const boardOrder = arrangeTiles(gridOrder, wins).map((p) => p.id);
  const board: Board = {
    shown,
    workspaceId: all.workspaceId,
    mode,
    layoutMode: view<ViewMode>(all, "view.layoutMode", "grid"),
    gridOrder,
    stripWidths: view(all, "strip.widths", {}),
    canvasRects: view(all, "canvas.rects", {}),
    camera: view(all, "canvas.camera", DEFAULT_CAMERA),
    storedDocks,
    docks,
    allRows,
    rows,
    flat,
    allFlat: flatten(allRows),
    windows,
    order: mode === "canvas" ? wins.map((p) => p.id) : boardOrder,
    boardOrder,
  };
  cache.set(all, board);
  return board;
}

/** Change a layout key of the shown workspace's view. */
export { setWorkspaceView as setView } from "../../lib/store.ts";

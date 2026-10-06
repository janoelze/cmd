// One sidebar (docs/21-sidebars.md): a docked window at the left or right edge,
// full height, floating on the backdrop like the workspace's windows. Same title
// bar, frame and menu as on the workspace; its inner edge resizes it (double-click:
// default width). Docking moves the window's DOM here, so a webview reloads once
// (Electron reattaches a moved <webview>); terminals reattach their xterm as is.

import type { PaneId } from "@cmd/protocol";
import { Window, WindowBody, WindowFrame } from "@cmd/ui";
import { needsYou, windowIdOf, type SidebarRow } from "../model.ts";
import { DOCK_WIDTH, type Side } from "../docks.ts";
import { PlacementContext } from "../windows/registry.ts";
import { TerminalView } from "./TerminalView.tsx";
import { TileTitle } from "./TileTitle.tsx";
import { WindowContent } from "./WindowsView.tsx";

interface Props {
  side: Side;
  row: SidebarRow;
  width: number;
  /** The widest it can get and leave the workspace its room. */
  maxWidth: number;
  selected: boolean;
  /** Something waits for you somewhere: outline windows that need you. */
  attention: boolean;
  onSelect: (id: PaneId) => void;
  onTitleMenu: (row: SidebarRow) => void;
  onTerminalMenu: (id: PaneId) => void;
  onWidth: (px: number | null) => void;
}

export function Dock(p: Props) {
  const id = windowIdOf(p.row)!;
  const r = p.row;
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    p.onSelect(id);
    p.onTitleMenu(r);
  };
  return (
    <aside className={`dock dock-${p.side}`} style={{ width: p.width }}>
      <Window
        data-pane={id}
        selected={p.selected}
        attention={p.attention && needsYou(r)}
        className={`tile dock-tile kind-${r.win?.kind ?? "terminal"} ${p.selected ? "sel" : ""} ${p.attention && needsYou(r) ? "needs" : ""}`}
        onMouseDown={() => p.onSelect(id)}
        onFocusCapture={() => !p.selected && p.onSelect(id)}
        // Right-clicks an embedded page reports (Magic widgets, embed.ts) open the title bar's menu.
        onContextMenu={(e) => e.target instanceof Element && e.target.closest("[data-embed]") && menu(e)}
      >
        <WindowBody className="tile-body">
          <TileTitle row={r} onContextMenu={menu} bare />
          <PlacementContext.Provider value="sidebar">
            {r.pane ? (
              <TerminalView paneId={id} focused={p.selected} onMenu={p.onTerminalMenu} />
            ) : r.win ? (
              <WindowContent win={r.win} focused={p.selected} />
            ) : null}
          </PlacementContext.Provider>
        </WindowBody>
        <WindowFrame className="tile-frame" />
      </Window>
      <DockResize side={p.side} max={p.maxWidth} onWidth={p.onWidth} />
    </aside>
  );
}

/**
 * The inner edge: drag to resize, double-click for the default width. While
 * dragging only the side's width style changes; the width is stored on release.
 */
function DockResize({ side, max, onWidth }: { side: Side; max: number; onWidth: (px: number | null) => void }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const dock = handle.closest<HTMLElement>(".dock");
    const app = handle.closest<HTMLElement>(".app");
    if (!dock || !app) return;
    handle.setPointerCapture(e.pointerId);
    app.classList.add("sidebar-resizing");
    const startX = e.clientX;
    const startW = dock.getBoundingClientRect().width;
    const min = DOCK_WIDTH.min;
    let width: number | null = null;
    const move = (ev: PointerEvent) => {
      const dx = side === "left" ? ev.clientX - startX : startX - ev.clientX;
      width = Math.round(Math.max(min, Math.min(max, startW + dx)));
      dock.style.width = `${width}px`;
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      app.classList.remove("sidebar-resizing");
      if (width !== null) onWidth(width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  // The window's inner edge: the right one for the left sidebar, and the other way round.
  return (
    <div
      className="resize-edge dock-resize"
      data-edge={side === "left" ? "right" : "left"}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onWidth(null)}
      data-tip="Drag to resize · double-click to reset"
    />
  );
}

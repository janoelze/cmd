import type { PaneId } from "@cmd/protocol";
import type { SidebarRow } from "../model.ts";
import type { Camera } from "../canvas.ts";
import type { Rect } from "../layouts.ts";
import { WindowsView } from "./WindowsView.tsx";

export type { ViewMode } from "../layouts.ts";
import type { ViewMode } from "../layouts.ts";

interface Props {
  mode: ViewMode;
  rows: SidebarRow[]; // flattened, display order
  selected: PaneId | null;
  onSelect: (paneId: PaneId) => void;
  onTerminalMenu: (paneId: PaneId) => void;
  onTitleMenu?: (row: SidebarRow) => void;
  gridOrder: PaneId[];
  onGridReorder: (order: PaneId[]) => void;
  stripWidths: Record<PaneId, number>;
  onStripWidth: (id: PaneId, fraction: number) => void;
  canvasRects: Record<PaneId, Rect>;
  onCanvasRects: (rects: Record<PaneId, Rect>) => void;
  camera: Camera;
  onCamera: (cam: Camera) => void;
  onDeselect: () => void;
}

export function MainView({
  mode,
  rows,
  selected,
  onSelect,
  onTerminalMenu,
  onTitleMenu,
  gridOrder,
  onGridReorder,
  stripWidths,
  onStripWidth,
  canvasRects,
  onCanvasRects,
  camera,
  onCamera,
  onDeselect,
}: Props) {
  // Every row that has a window: terminals and browser/file windows.
  const withPane = rows.filter((r) => !!(r.pane || r.win));

  if (withPane.length === 0) {
    return (
      <main className="main empty-main">
        <div className="hello">
          <div className="hello-title">cmd</div>
          <p>
            <kbd>⌘T</kbd> new terminal · <kbd>⌘K</kbd> commands
          </p>
        </div>
      </main>
    );
  }

  return (
    <WindowsView
      mode={mode}
      rows={withPane}
      order={gridOrder}
      onReorder={onGridReorder}
      widths={stripWidths}
      onWidth={onStripWidth}
      selected={selected}
      onSelect={onSelect}
      onTerminalMenu={onTerminalMenu}
      onTitleMenu={onTitleMenu}
      canvasRects={canvasRects}
      onCanvasRects={onCanvasRects}
      camera={camera}
      onCamera={onCamera}
      onDeselect={onDeselect}
    />
  );
}

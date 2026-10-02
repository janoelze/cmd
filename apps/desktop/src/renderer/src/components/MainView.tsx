import type { Pane, PaneId } from "@cmd/protocol";
import type { SidebarRow } from "../model.ts";
import { WindowsView } from "./WindowsView.tsx";

export type { ViewMode } from "../layouts.ts";
import type { ViewMode } from "../layouts.ts";

interface Props {
  mode: ViewMode;
  rows: SidebarRow[]; // flattened, display order
  selected: PaneId | null;
  onSelect: (paneId: PaneId) => void;
  onTerminalMenu: (paneId: PaneId) => void;
  gridOrder: PaneId[];
  onGridReorder: (order: PaneId[]) => void;
  stripWidths: Record<PaneId, number>;
  onStripWidth: (id: PaneId, fraction: number) => void;
}

export function MainView({
  mode,
  rows,
  selected,
  onSelect,
  onTerminalMenu,
  gridOrder,
  onGridReorder,
  stripWidths,
  onStripWidth,
}: Props) {
  const withPane = rows.filter((r): r is SidebarRow & { pane: Pane } => !!r.pane);

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

  if (mode === "canvas") {
    return (
      <main className="main empty-main">
        <div className="hello">
          <div className="hello-title">Canvas</div>
          <p>Infinite canvas is on the roadmap — see docs/02 and docs/07.</p>
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
    />
  );
}

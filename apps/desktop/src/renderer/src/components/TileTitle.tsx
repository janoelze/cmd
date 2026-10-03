// Title bar of a window tile (grid and strip). Terminals: status, title, process,
// path, usage. Browser and file windows: icon, title, host or folder.

import { ledOf, rowTitle, shortPath, usageLabel, usageTooltip, type SidebarRow } from "../model.ts";
import { typeFor, viewFor } from "../windows/registry.ts";
import { useStoreValue } from "../store.ts";
import { useWindowStatus } from "../windowActions.ts";
import { ICON, Symbol } from "./Symbol.tsx";

/** SF Symbol for a window kind (from the core's window type registry). */
export const iconFor = (kind: string) => typeFor(kind)?.icon ?? "macwindow";

export function TileTitle({
  row,
  onPointerDown,
  onContextMenu,
  onDoubleClick,
  title,
}: {
  row: SidebarRow;
  onPointerDown?: (e: React.PointerEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  title?: string;
}) {
  const showUsage = useStoreValue((s) => s.settings.settings["ui.showResources"]);
  const { pane, win } = row;
  const status = useWindowStatus(win?.id ?? null);
  return (
    <div className="tile-title" onPointerDown={onPointerDown} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick} title={title}>
      {win && win.kind !== "terminal" ? (
        <Symbol name={iconFor(win.kind)} size={ICON.small} className="tile-icon" />
      ) : (
        <span className={`led led-${ledOf(row.agent)}`} />
      )}
      <span className="tile-name">
        {rowTitle(row)}
        {status?.dirty && <span className="dirty-dot" title="Unsaved changes" />}
      </span>
      <span className="tile-meta">
        {pane && (
          <>
            <span className="tile-proc">{pane.foreground}</span>
            <span className="tile-path">{shortPath(pane.cwd)}</span>
            {showUsage && pane.usage && (
              <span className="tile-usage" title={usageTooltip(pane.usage)}>
                {usageLabel(pane.usage)}
              </span>
            )}
          </>
        )}
        {win && viewFor(win.kind)?.meta?.(win)}
      </span>
    </div>
  );
}

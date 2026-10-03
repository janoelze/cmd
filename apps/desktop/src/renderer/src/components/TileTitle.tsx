// Title bar of a window tile (grid and strip). Terminals: status, title, process,
// path, usage. Browser and file windows: icon, title, host or folder.

import { hostOf, ledOf, rowTitle, shortPath, usageLabel, usageTooltip, type SidebarRow } from "../model.ts";
import { useStore } from "../store.ts";
import { useWindowStatus } from "../windowActions.ts";
import { Symbol } from "./Symbol.tsx";

export const WINDOW_ICONS = { browser: "globe", files: "folder", text: "doc.text" } as const;

export function TileTitle({
  row,
  onPointerDown,
  onContextMenu,
  title,
}: {
  row: SidebarRow;
  onPointerDown?: (e: React.PointerEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
}) {
  const showUsage = useStore().settings.settings["ui.showResources"];
  const { pane, win } = row;
  const status = useWindowStatus(win?.id ?? null);
  const folder = (p: string | null) => shortPath((p ?? "").split("/").slice(0, -1).join("/") || "/");
  return (
    <div className="tile-title" onPointerDown={onPointerDown} onContextMenu={onContextMenu} title={title}>
      {win && win.kind !== "terminal" ? (
        <Symbol name={WINDOW_ICONS[win.kind]} size={11} className="tile-icon" />
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
        {win?.kind === "browser" && <span className="tile-path">{hostOf(win.url)}</span>}
        {win?.kind === "files" && <span className="tile-path">{shortPath(win.path ?? "")}</span>}
        {win?.kind === "text" && (
          <>
            <span className="tile-path">{folder(win.path)}</span>
            {status && <span className="tile-usage">{status.label}</span>}
          </>
        )}
      </span>
    </div>
  );
}

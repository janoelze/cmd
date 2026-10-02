// Title bar of a terminal tile (grid and strip): status, title, process, path, usage.

import type { Pane } from "@cmd/protocol";
import { ledOf, rowTitle, shortPath, usageLabel, usageTooltip, type SidebarRow } from "../model.ts";
import { useStore } from "../store.ts";

export function TileTitle({
  row,
  onPointerDown,
  title,
}: {
  row: SidebarRow & { pane: Pane };
  onPointerDown?: (e: React.PointerEvent) => void;
  title?: string;
}) {
  const showUsage = useStore().settings.settings["ui.showResources"];
  const { pane } = row;
  return (
    <div className="tile-title" onPointerDown={onPointerDown} title={title}>
      <span className={`led led-${ledOf(row.agent)}`} />
      <span className="tile-name">{rowTitle(row)}</span>
      <span className="tile-meta">
        <span className="tile-proc">{pane.foreground}</span>
        <span className="tile-path">{shortPath(pane.cwd)}</span>
        {showUsage && pane.usage && (
          <span className="tile-usage" title={usageTooltip(pane.usage)}>
            {usageLabel(pane.usage)}
          </span>
        )}
      </span>
    </div>
  );
}

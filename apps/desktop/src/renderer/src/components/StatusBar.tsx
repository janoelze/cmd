// Bottom bar of the main pane: the current session on the left, view modes and
// actions on the right. Shares its row (and height) with the sidebar's footer.

import type { Pane } from "@cmd/protocol";
import { prettyAccelerator, type CommandId } from "../../../shared/commands.ts";
import { useKeybindings } from "../keybindings.ts";
import { ledOf, rowDetail, shortPath, usageLabel, usageTooltip, type SidebarRow } from "../model.ts";
import { useStore } from "../store.ts";
import type { ViewMode } from "./MainView.tsx";
import { Symbol } from "./Symbol.tsx";

const ICONS: Record<ViewMode | "new" | "palette" | "settings", string> = {
  focus: "rectangle",
  grid: "square.grid.2x2",
  strip: "rectangle.split.3x1",
  canvas: "rectangle.3.group",
  new: "plus",
  palette: "command",
  settings: "gearshape",
};

interface Props {
  mode: ViewMode;
  row: SidebarRow | undefined;
  pane: Pane | undefined;
  run: (id: CommandId) => void;
}

export function StatusBar({ mode, row, pane, run }: Props) {
  const keys = useKeybindings();
  const showUsage = useStore().settings.settings["ui.showResources"];
  const tip = (label: string, id: CommandId) => {
    const k = prettyAccelerator(keys.bindings[id]?.[0]);
    return k ? `${label} (${k})` : label;
  };
  const btn = (id: CommandId, icon: string, label: string, on = false) => (
    <button key={id} className={`icon-btn ${on ? "on" : ""}`} title={tip(label, id)} aria-label={label} onClick={() => run(id)}>
      <Symbol name={icon} size={15} />
    </button>
  );

  return (
    <footer className="statusbar">
      <div className="statusbar-session">
        {!pane && row?.win && (
          <>
            <span className="statusbar-proc">{row.win.kind}</span>
            <span className="statusbar-path">{row.win.kind === "browser" ? (row.win.url ?? "") : shortPath(row.win.path ?? "")}</span>
          </>
        )}
        {pane && (
          <>
            <span className={`led led-${ledOf(row?.agent ?? null)}`} />
            <span className="statusbar-proc">{pane.foreground}</span>
            <span className="statusbar-path">{shortPath(pane.cwd)}</span>
            {row?.agent && <span className="statusbar-detail">{rowDetail(row, Date.now())}</span>}
            {showUsage && pane.usage && (
              <span className="statusbar-usage" title={usageTooltip(pane.usage)}>
                {usageLabel(pane.usage)}
              </span>
            )}
          </>
        )}
      </div>
      <div className="statusbar-actions">
        {btn("file.newTerminal", ICONS.new, "New Terminal")}
        <span className="statusbar-sep" />
        {btn("view.focus", ICONS.focus, "Focus", mode === "focus")}
        {btn("view.grid", ICONS.grid, "Grid", mode === "grid")}
        {btn("view.strip", ICONS.strip, "Strip", mode === "strip")}
        {btn("view.canvas", ICONS.canvas, "Canvas", mode === "canvas")}
        <span className="statusbar-sep" />
        {btn("view.palette", ICONS.palette, "Command Palette")}
        {btn("app.settings", ICONS.settings, "Settings")}
      </div>
    </footer>
  );
}

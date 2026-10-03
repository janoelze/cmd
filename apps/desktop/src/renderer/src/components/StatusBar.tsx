// Bottom bar of the main pane: the selected window's usage on the left (all its
// title fields in focus mode), view modes and actions on the right. Shares its
// row (and height) with the sidebar's footer.

import type { Pane } from "@cmd/protocol";
import { prettyAccelerator, type CommandId } from "../../../shared/commands.ts";
import { useKeybindings } from "../keybindings.ts";
import { usageLabel, usageTooltip, type SidebarRow } from "../model.ts";
import { useStoreValue } from "../store.ts";
import { DirtyDot, Mark, Slot } from "./Slot.tsx";
import { useFields } from "./TileTitle.tsx";
import type { ViewMode } from "./MainView.tsx";
import { ICON, Symbol } from "./Symbol.tsx";

const ICONS: Record<ViewMode | "palette" | "settings", string> = {
  focus: "rectangle",
  grid: "square.grid.2x2",
  strip: "rectangle.split.3x1",
  canvas: "rectangle.3.group",
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
  const showUsage = useStoreValue((s) => s.settings.settings["ui.showResources"]);
  const f = useFields(row);
  const tip = (label: string, id: CommandId) => {
    const k = prettyAccelerator(keys.bindings[id]?.[0]);
    return k ? `${label} (${k})` : label;
  };
  const btn = (id: CommandId, icon: string, label: string, on = false) => (
    <button key={id} className={`icon-btn ${on ? "on" : ""}`} title={tip(label, id)} aria-label={label} onClick={() => run(id)}>
      <Symbol name={icon} size={ICON.bar} />
    </button>
  );

  return (
    <footer className="statusbar">
      {/* The title bar and sidebar already show the window's fields; the status bar adds
          what they don't: the processes' memory and CPU. Focus mode has no title bar,
          so there the status bar stands in for it. */}
      <div className="statusbar-session">
        {mode === "focus" && f && (
          <>
            <Mark light={f.light} icon={f.icon} />
            <Slot className="statusbar-name" value={{ text: f.name }} fade />
            <DirtyDot on={!!f.dirty} />
            <Slot className="statusbar-proc" value={f.kind ? { text: f.kind } : undefined} />
            <Slot className="statusbar-path" value={f.place ? { text: f.place } : undefined} clipStart divider={!!f.kind} />
            <Slot className="statusbar-detail" value={f.status} divider={!!(f.kind || f.place)} />
          </>
        )}
        <Slot
          className="statusbar-usage"
          value={showUsage && pane?.usage ? { text: usageLabel(pane.usage) ?? "", key: "usage" } : undefined}
          title={usageTooltip(pane?.usage ?? null)}
        />
      </div>
      <div className="statusbar-actions">
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

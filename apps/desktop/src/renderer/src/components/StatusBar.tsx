// Bottom bar of the main pane: the selected window's usage on the left (all its
// title fields in focus mode), view modes and actions on the right. Shares its
// row (and height) with the sidebar's footer.

import type { Pane } from "@cmd/protocol";
import { prettyAccelerator, type CommandId } from "../../../shared/commands.ts";
import { useKeybindings } from "../keybindings.ts";
import { formatBytes, usageLabel, windowIdOf, type SidebarRow } from "../model.ts";
import { useStoreValue } from "../store.ts";
import { DirtyDot, Mark, Slot } from "./Slot.tsx";
import { useFields } from "./TileTitle.tsx";
import type { ViewMode } from "./MainView.tsx";
import { ICON, Symbol } from "./Symbol.tsx";
import { RemoteBadge, RemoteIndicator } from "./Remote.tsx";
import { IconButton, Segmented, useTooltip } from "@cmd/ui";
import { countRender } from "../perf.ts";

const MODE_LABEL: Record<ViewMode, string> = { focus: "Focus", grid: "Grid", strip: "Strip", canvas: "Canvas" };

const ICONS: Record<ViewMode | "palette" | "settings" | "feedback", string> = {
  focus: "rectangle",
  grid: "square.grid.2x2",
  strip: "rectangle.split.3x1",
  canvas: "rectangle.3.group",
  palette: "command",
  settings: "gearshape",
  feedback: "bubble.left",
};

interface Props {
  mode: ViewMode;
  row: SidebarRow | undefined;
  pane: Pane | undefined;
  run: (id: CommandId) => void;
}

export function StatusBar({ mode, row, pane, run }: Props) {
  countRender("StatusBar");
  const keys = useKeybindings();
  const showUsage = useStoreValue((s) => s.settings.settings["ui.showResources"]);
  const f = useFields(row);
  const usage = pane?.usage ?? null;
  const usageTip = useTooltip(() => usage && <UsageTip usage={usage} />);
  const key = (id: CommandId) => prettyAccelerator(keys.bindings[id]?.[0]);
  const btn = (id: CommandId, icon: string, label: string) => <IconButton key={id} icon={icon} label={label} shortcut={key(id)} iconSize={ICON.bar} onClick={() => run(id)} />;
  const modes = (["focus", "grid", "strip", "canvas"] as const).map((m) => ({ value: m, icon: ICONS[m], tip: MODE_LABEL[m], shortcut: key(`view.${m}`) }));

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
            <RemoteBadge id={row ? windowIdOf(row) : null} />
          </>
        )}
        <span ref={showUsage && usage ? usageTip : undefined} className="statusbar-usage-tip">
          <Slot className="statusbar-usage" value={showUsage && usage ? { text: usageLabel(usage) ?? "", key: "usage" } : undefined} />
        </span>
      </div>
      <div className="statusbar-actions">
        <Segmented size="sm" label="View" value={mode} options={modes} onChange={(m) => run(`view.${m}`)} />
        <span className="statusbar-sep" />
        <RemoteIndicator />
        {btn("help.feedback", ICONS.feedback, "Send Feedback")}
        {btn("view.palette", ICONS.palette, "Command Palette")}
        {btn("app.settings", ICONS.settings, "Settings")}
      </div>
    </footer>
  );
}

/** The usage's tooltip: totals, then the largest processes in the tree. */
function UsageTip({ usage: u }: { usage: NonNullable<Pane["usage"]> }) {
  return (
    <>
      <div className="tip-head">
        {formatBytes(u.memory)} memory · {u.cpu.toFixed(1)}% CPU · {u.processes} process{u.processes === 1 ? "" : "es"}
      </div>
      {u.top.length > 0 && (
        <div className="tip-rows">
          {u.top.map((t, i) => [<span key={`m${i}`}>{formatBytes(t.memory)}</span>, <span key={`n${i}`}>{t.name}</span>])}
        </div>
      )}
    </>
  );
}

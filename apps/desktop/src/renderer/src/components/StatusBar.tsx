// The footer: one bar across the app window's bottom (docs/21-sidebars.md). The
// core's health on the left, then the selected window's usage; the app's actions
// on the right. View modes are in the top bar.

import type { Pane } from "@cmd/protocol";
import { prettyAccelerator, type CommandId } from "../../../shared/commands.ts";
import { useKeybindings } from "../keybindings.ts";
import { formatBytes, usageLabel } from "../model.ts";
import { useStoreValue } from "../store.ts";
import { Slot } from "./Slot.tsx";
import { ICON } from "./Symbol.tsx";
import { RemoteIndicator } from "./Remote.tsx";
import { CoreStatus } from "./CoreStatus.tsx";
import { IconButton, useTooltip } from "@cmd/ui";
import { useSyncExternalStore } from "react";
import { countRender } from "../perf.ts";

const ICONS: Record<"palette" | "settings" | "feedback" | "whatsNew", string> = {
  palette: "command",
  settings: "gearshape",
  feedback: "bubble.left",
  whatsNew: "sparkles",
};

// The footer's centre: where the strip view puts its page dots (WindowsView), so its
// windows end where the sidebars and the other modes' windows do.
let centre: HTMLElement | null = null;
const centreListeners = new Set<() => void>();
const setCentre = (el: HTMLElement | null) => {
  if (el === centre) return;
  centre = el;
  for (const fn of centreListeners) fn();
};
/** The footer's centre element, for a portal; null until the footer mounts. */
export function useFooterCentre(): HTMLElement | null {
  return useSyncExternalStore(
    (fn) => (centreListeners.add(fn), () => void centreListeners.delete(fn)),
    () => centre,
  );
}

interface Props {
  pane: Pane | undefined;
  run: (id: CommandId) => void;
  /** The core's connection, for its health at the left end. */
  connected: boolean;
  error?: string;
}

export function StatusBar({ pane, run, connected, error }: Props) {
  countRender("StatusBar");
  const keys = useKeybindings();
  const showUsage = useStoreValue((s) => s.settings.settings["ui.showResources"]);
  const usage = pane?.usage ?? null;
  const usageTip = useTooltip(() => usage && <UsageTip usage={usage} />);
  const key = (id: CommandId) => prettyAccelerator(keys.bindings[id]?.[0]);
  const btn = (id: CommandId, icon: string, label: string) => <IconButton key={id} icon={icon} label={label} shortcut={key(id)} iconSize={ICON.bar} onClick={() => run(id)} />;

  return (
    <footer className="statusbar">
      <div className="statusbar-core">
        <CoreStatus connected={connected} error={error} />
      </div>
      {/* The title bar and the Navigator already show the window's fields (focus mode
          too); the footer adds what they don't: the processes' memory and CPU. */}
      <div className="statusbar-session">
        <span ref={showUsage && usage ? usageTip : undefined} className="statusbar-usage-tip">
          <Slot className="statusbar-usage" value={showUsage && usage ? { text: usageLabel(usage) ?? "", key: "usage" } : undefined} />
        </span>
      </div>
      <div className="statusbar-centre" ref={setCentre} />
      <div className="statusbar-actions">
        <RemoteIndicator />
        {btn("help.whatsNew", ICONS.whatsNew, "What's New")}
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

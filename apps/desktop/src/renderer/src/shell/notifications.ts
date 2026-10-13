// Notifications as this app window presents them. The core decides what is worth telling
// (packages/core/src/notifications/center.ts); here, whether and how to show it, since only
// the UI knows focus and selection: an agent you watched finish isn't news, agents that
// finish close together are one notification. Looking at a window counts as seeing it. Plus
// the Dock: its badge (what waits, everywhere) and progress bar (OSC 9;4).

import { useEffect, useMemo, useState } from "react";
import { toast } from "@cmd/ui";
import type { PaneId } from "@cmd/protocol";
import { bucketOf, needsAttention } from "@cmd/protocol";
import { cmd } from "../lib/bridge.ts";
import { windowAttention } from "../lib/model.ts";
import { select } from "../lib/selection.ts";
import { getState, onNotification, useStoreValue, type State } from "../lib/store.ts";
import { DoneBatch, Looks } from "./notify.ts";

/** Visual bell: flash the window's outline (restarts if it's already flashing). */
function flashWindow(paneId: PaneId): void {
  const tile = document.querySelector<HTMLElement>(`.tile[data-pane="${CSS.escape(paneId)}"]`);
  if (!tile) return;
  tile.classList.remove("bell");
  void tile.offsetWidth; // restart the animation
  tile.classList.add("bell");
  // Only the tile's own animation: title-bar slots inside it animate too.
  const done = (e: AnimationEvent) => {
    if (e.target !== tile) return;
    tile.classList.remove("bell");
    tile.removeEventListener("animationend", done);
  };
  tile.addEventListener("animationend", done);
}

function useAppFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => (window.removeEventListener("focus", on), window.removeEventListener("blur", off));
  }, []);
  return focused;
}

/** Shows the core's notifications as this window should, and marks what you look at as seen. */
export function useNotifications(selected: PaneId | null, shown: State): void {
  const appFocused = useAppFocused();
  // What you look at and when you looked away (notify.ts).
  const [looks] = useState(() => new Looks());
  const [doneBatch] = useState(() => new DoneBatch());
  useEffect(() => {
    looks.look(appFocused ? selected : null);
    if (appFocused && selected) doneBatch.seen(selected);
  }, [selected, appFocused]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only what it reads: on every store change this sent IPC (closeNotification) and repeated RPCs.
  const pane = selected ? shown.panes.get(selected) : undefined;
  const agent = pane ? shown.agents.get(pane.agentId ?? "") : undefined;
  const unseen = !!agent && bucketOf(agent) === "unseen";
  const paneAttention = !!pane?.attention;
  const winAttention = !!windowAttention(selected ? shown.windows.get(selected) : null);
  useEffect(() => {
    if (!selected || !appFocused) return;
    if (unseen && agent) void cmd.call("agent.markSeen", { agentId: agent.id }).catch(() => {});
    if (paneAttention) void cmd.call("pane.clearAttention", { paneId: selected });
    if (winAttention) void cmd.call("window.clearAttention", { id: selected });
    cmd.closeNotification(selected);
  }, [selected, appFocused, unseen, paneAttention, winAttention]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const offClick = cmd.onNotificationClick((paneId) => select(paneId));
    const off = onNotification((n) => {
      const c = getState().settings.settings;
      if (n.source === "bell" && n.paneId && c["notifications.visualBell"]) flashWindow(n.paneId);
      if (!n.alert) return;
      // The window it's about: a terminal, or another window (a widget).
      const from = n.paneId ?? n.windowId ?? null;
      const st = getState();
      const looking = document.hasFocus() && from !== null && from === (st.workspaces.get(st.workspaceId)?.view["selection.pane"] ?? null);
      // An agent that finished while you watched it, or just after you looked away: you saw it.
      const saw = looking || (n.done !== undefined && from !== null && looks.saw(from, n.at));
      if (c["notifications.when"] === "never" || (c["notifications.when"] === "background" && saw)) return;
      // Agents that finish close together: one notification for all of them.
      const shownAs = n.done !== undefined && from !== null ? doneBatch.add({ tag: from, name: n.done, title: n.title, body: n.body, at: n.at }) : { tag: from ?? n.id, title: n.title, body: n.body, replaces: [] };
      for (const tag of shownAs.replaces) cmd.closeNotification(tag);
      const sound = c["notifications.sound"];
      cmd.notify({ tag: shownAs.tag, title: shownAs.title, body: shownAs.body, sound: n.urgent && sound !== "none" ? sound : null, paneId: from });
      const bounce = c["notifications.bounceDock"];
      if (!document.hasFocus() && (bounce === "any" || (bounce === "needsInput" && n.urgent))) cmd.bounce();
    });
    // Posted, but macOS won't show it (main says so once per launch).
    const offBlocked = cmd.onNotifyBlocked((access) =>
      toast(access === "off" ? "macOS has cmd's notifications turned off" : "macOS shows cmd's notifications without a banner", {
        tone: "warning",
        duration: 10_000,
        action: { label: "Open System Settings", run: () => cmd.openNotifySettings() },
      }),
    );
    // A site was allowed the camera or microphone, but macOS won't give it to cmd (main: web-session.ts).
    const offMedia = cmd.onMediaBlocked((devices) =>
      toast(`macOS has cmd's ${devices.includes("camera") ? (devices.includes("microphone") ? "camera and microphone" : "camera") : "microphone"} turned off`, {
        tone: "warning",
        duration: 10_000,
        action: { label: "Open System Settings", run: () => cmd.openMediaSettings(devices[0]!) },
      }),
    );
    return () => (off(), offClick(), offBlocked(), offMedia());
  }, [looks, doneBatch]);
}

/** The Dock's badge (agents, terminals and widgets waiting, in every workspace) and progress bar (the average of the terminals reporting one). */
export function useDock(): void {
  const agents = useStoreValue((s) => s.agents);
  const panes = useStoreValue((s) => s.panes);
  const windows = useStoreValue((s) => s.windows);
  const badge = useStoreValue((s) => s.settings.settings["notifications.dockBadge"]);
  const attention = useMemo(
    () => [...agents.values()].filter(needsAttention).length + [...panes.values()].filter((p) => p.attention && !p.agentId).length + [...windows.values()].filter((w) => windowAttention(w)).length,
    [agents, panes, windows],
  );
  useEffect(() => cmd.setBadge(badge ? attention : 0), [attention, badge]);
  const progress = useMemo(() => {
    const bars = [...panes.values()].flatMap((p) => (p.progress ? [p.progress] : []));
    if (!bars.length) return -1;
    if (bars.every((b) => b.state === "indeterminate")) return 2; // >1: indeterminate
    const valued = bars.filter((b) => b.state !== "indeterminate");
    return valued.reduce((n, b) => n + b.value, 0) / valued.length / 100;
  }, [panes]);
  useEffect(() => cmd.setProgress(progress), [progress]);
}

// Right-click menus of the shell: a row (a window, an agent: the Navigator, title bars), a
// workspace in the switcher, a terminal. What is also an app command is that command, run for
// the row it is on (registry.ts commandItem): same label, shortcut and enablement as in the
// menu bar. The rest are one-off entries.

import type { PaneId, Workspace } from "@cmd/protocol";
import { aiStatus } from "../ai/status.ts";
import { copy, newTerminalIn } from "../lib/actions.ts";
import { cmd } from "../lib/bridge.ts";
import { showContextMenu, type MenuEntry } from "../lib/context.ts";
import { windowIdOf, type SidebarRow } from "../lib/model.ts";
import { select } from "../lib/selection.ts";
import { getState } from "../lib/store.ts";
import { viewFor } from "../windows/registry.ts";
import { terminals } from "../windows/terminal/terminals.ts";
import { boardOf } from "./board/board.ts";
import { dock, sideOf, SIDES } from "./board/docks.ts";
import { setDocks } from "./board/view.ts";
import { commandItem, commandContext, type Target } from "./commands/registry.ts";
import { showWorkspace } from "./workspaces.tsx";

/** The terminal a row lives in: its own, or for a subagent (no window of its own) its host's. */
export function homeOf(r: SidebarRow): string | null {
  const own = windowIdOf(r);
  if (own) return own;
  const agents = getState().agents;
  let at = r.agent;
  while (at && !at.paneId && at.parentId) at = agents.get(at.parentId) ?? null;
  return at?.paneId ?? null;
}

/** Per-terminal mute: no system notifications from it (its marker still shows). */
const muteEntry = (paneId: PaneId): MenuEntry => {
  const muted = !!getState().panes.get(paneId)?.muted;
  return { label: muted ? "Unmute Notifications" : "Mute Notifications", run: () => void cmd.call("pane.setMuted", { paneId, muted: !muted }).catch(() => {}) };
};

/** On the board: Make Sidebar ▸ Left / Right; on a sidebar: the other side, or back (docs/21-sidebars.md). */
const sidebarEntries = (id: string): MenuEntry[] => {
  const t: Target = { windowId: id };
  if (!sideOf(boardOf(getState()).docks, id))
    return [{ label: "Make Sidebar", submenu: SIDES.map((sd) => ({ label: sd === "left" ? "Left" : "Right", run: () => setDocks((d) => dock(d, id, sd)) })) }];
  return [commandItem("window.dockLeft", t), commandItem("window.dockRight", t), commandItem("window.undock", t)].filter((e) => e.enabled !== false);
};

export function rowMenu(r: SidebarRow): void {
  const a = r.agent;
  const id = windowIdOf(r);
  const t: Target = id ? { windowId: id } : a ? { agentId: a.id } : {};
  const folder = commandContext(t).folder;
  const own = r.win ? (viewFor(r.win.kind)?.actions?.(r.win) ?? []) : [];
  void showContextMenu([
    ...(own.length ? [...own, "-" as const] : []),
    ...(id
      ? [
          { label: "Show", run: () => select(id) },
          ...(r.pane ? [muteEntry(r.pane.id)] : []),
          ...sidebarEntries(id),
          commandItem("workspace.moveWindow", t, { label: "Move to Workspace…" }),
          commandItem("window.close", t, { label: r.pane ? "Close Terminal" : "Close Window" }),
          "-" as const,
        ]
      : a
        ? [
            // A subagent, or a host whose terminal is gone: no window of its own.
            ...(homeOf(r) ? [{ label: "Show Host", run: () => select(homeOf(r)!) }] : []),
            { label: "Remove", run: () => void cmd.call("agent.kill", { agentId: a.id }) },
            "-" as const,
          ]
        : []),
    // Entries the window's type contributes (see windows/registry.ts).
    ...(r.win ? [...(viewFor(r.win.kind)?.menu?.(r.win) ?? []), "-" as const] : []),
    ...(a
      ? [
          commandItem("session.rename", t, { label: "Rename…" }),
          commandItem("session.copyResume", t),
          commandItem("session.copyId", t),
          // Only with an AI provider set up; read when the menu opens, so a key added since counts.
          ...(aiStatus()?.ready ? [commandItem("session.summarize", t)] : []),
          ...(a.native.transcriptPath ? [{ label: "Reveal Transcript", run: () => cmd.openPath(a.native.transcriptPath!, { from: "user" }) }] : []),
          "-" as const,
        ]
      : []),
    ...(folder
      ? [
          { label: "New Terminal Here", run: () => void newTerminalIn(folder) },
          commandItem("session.reveal", t),
          { label: "Copy Path", run: () => copy(folder) },
        ]
      : []),
  ]);
}

/** Right-click on a workspace in the switcher. */
export function workspaceMenu(sp: Workspace): void {
  const here = getState().workspaceId;
  const t: Target = { workspaceId: sp.id };
  void showContextMenu([
    { label: "Show", run: () => showWorkspace(sp.id), enabled: sp.id !== here },
    { label: "Open in New Window", run: () => showWorkspace(sp.id, { newWindow: true }), enabled: sp.id !== here },
    "-",
    commandItem("workspace.rename", t, { label: "Rename…" }),
    commandItem("workspace.icon", t, { label: "Change Icon…" }),
    commandItem("workspace.reveal", t, { label: "Show Folder in Finder" }),
    { label: "Copy Path", run: () => copy(sp.root) },
    "-",
    commandItem("workspace.close", t),
  ]);
}

export function terminalMenu(paneId: PaneId): void {
  select(paneId);
  const t: Target = { windowId: paneId };
  void showContextMenu([
    commandItem("edit.copy", t),
    { label: "Paste", run: () => void navigator.clipboard.readText().then((x) => terminals.paste(paneId, x)) },
    commandItem("edit.selectAll", t),
    commandItem("edit.copyLastOutput", t),
    commandItem("edit.find", t),
    "-",
    commandItem("edit.clear", t),
    {
      // For when a crashed program leaves modes on (mouse reporting, odd charsets).
      label: "Reset Terminal",
      run: () => {
        terminals.reset(paneId);
        void cmd.call("pane.reset", { paneId }).catch(() => {});
      },
    },
    "-",
    muteEntry(paneId),
    "-",
    commandItem("window.close", t, { label: "Close Terminal" }),
  ]);
}

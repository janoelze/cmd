// The terminals' methods (pane.*): open one where the call belongs, type into it, size it,
// read it, end it. Typing at the Mac takes a terminal back from a device sizing it.

import type { CoreContext } from "../kernel/context.ts";
import { IN_CORE, slice } from "../kernel/handlers.ts";
import { waitForPane } from "./wait.ts";

/** Who sizes a terminal for calls from inside the core (tests). */
const IN_PROCESS = {};
/** What a terminal sends by itself (focus in/out, device attributes, cursor position): not typing. */
const REPORTS = /^(\x1b\[[\d;?>]*[IOcRn])+$/;

export const paneHandlers = (core: CoreContext) =>
  slice({
    "pane.create": (p) => {
      const workspace = core.place(p, { path: p.cwd });
      const pane = core.panes.create({ ...p, cwd: p.cwd ?? workspace.root, workspaceId: workspace.id, openerId: p.openerId ?? p.callerPaneId });
      core.usage.window("terminal");
      return pane;
    },
    "pane.list": () => core.panes.list(),
    "pane.write": (p, { conn } = IN_CORE) => {
      core.panes.write(p.paneId, p.data);
      if (conn?.access === "local" && !REPORTS.test(p.data)) (core.panes.release(p.paneId), core.remote.push.typed());
      else if (conn && conn.access !== "local") core.remote.input(conn, p.paneId);
      return null;
    },
    "pane.resize": (p) => (core.panes.resize(p.paneId, p.cols, p.rows), null),
    // The override belongs to the caller: a device's ends when its session does.
    "pane.fitOverride": (p, { conn } = IN_CORE) => {
      const owner = conn ?? IN_PROCESS;
      if ("release" in p) core.panes.release(p.paneId, owner);
      else core.panes.override(p.paneId, owner, !conn || conn.access === "local" ? "this Mac" : core.remote.nameOf(conn), p.cols, p.rows);
      return null;
    },
    "pane.reclaim": (p) => (core.panes.release(p.paneId), null),
    "pane.kill": async (p) => (await core.windowOps.closeTerminal(p.paneId), null),
    "pane.setMuted": (p) => (core.notifications.setMuted(p.paneId, p.muted), null),
    "pane.clearAttention": (p) => (core.notifications.clearAttention(p.paneId), null),
    "pane.snapshot": (p) => core.panes.snapshot(p.paneId),
    "pane.read": async (p) => ({ text: await core.panes.read(p.paneId, p.lines) }),
    "pane.waitFor": (p) => waitForPane(core.panes, p.paneId, p),
    "pane.reset": async (p) => (await core.panes.resetState(p.paneId), null),
  });

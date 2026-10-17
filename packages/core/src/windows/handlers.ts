// The windows' methods (window.*, and video.trim for the Video window): open, change, move, close and reopen them, and which ones a
// client shows (window.follow, so a remote session gets output only for those).

import { actOnPage, readPage } from "./pages.ts";
import { appAsk } from "./app-ask.ts";
import type { CoreContext } from "../kernel/context.ts";
import { IN_CORE, slice } from "../kernel/handlers.ts";
import { trimVideo } from "./video.ts";

export const windowHandlers = (core: CoreContext) =>
  slice({
    "window.open": (p) => core.windowOps.open(p),
    "window.update": (p) => core.windows.update(p.id, p),
    "window.types": () => core.windowTypes.info(),
    "window.close": async (p) => (await core.windowOps.close(p.id), null),
    "browser.read": (p) => {
      const w = core.windows.others().find((x) => x.id === p.id);
      if (w?.kind !== "browser") throw new Error(w ? `${w.title} is not a browser window` : `no window ${p.id}`);
      return readPage(core, p.id, p.mode, p.selector, p.max);
    },
    "browser.reply": (p) => (appAsk(core).answer(p.reqId, p.result, p.error ?? (p.result ? undefined : "the page didn't answer")), null),
    "browser.act": (p) => {
      const w = core.windows.others().find((x) => x.id === p.id);
      if (w?.kind !== "browser") throw new Error(w ? `${w.title} is not a browser window` : `no window ${p.id}`);
      return actOnPage(core, p.id, p);
    },
    "browser.acted": (p) => (appAsk(core).answer(p.reqId, p.result, p.error ?? (p.result ? undefined : "the page didn't answer")), null),
    "workspace.arrange": async (p) => {
      core.workspaces.mustOpen(p.workspaceId);
      await appAsk(core).ask((reqId) => ({ type: "workspace.arrangeRequest", reqId, workspaceId: p.workspaceId, move: p.move }), 3000, "no app window shows this workspace right now");
      return null;
    },
    "workspace.arranged": (p) => (appAsk(core).answer(p.reqId, null, p.error), null),
    "window.select": (p) => {
      if (!core.windows.list().some((w) => w.id === p.id)) throw new Error(`no window ${p.id}`);
      core.broadcast({ type: "window.focus", id: p.id });
      return null;
    },
    "window.closed": (p) => core.closed.list(p.workspaceId),
    "window.reopen": (p) => core.windowOps.reopen(p),
    "window.clearAttention": (p) => {
      const w = core.windows.others().find((x) => x.id === p.id);
      if (w?.state.attention) core.windows.update(p.id, { state: { attention: null } });
      return null;
    },
    "window.list": () => core.windows.list(),
    "window.openTarget": (p) => core.opened(core.windows.openTarget(p.target, core.place(p, { path: /^[a-z][\w+.-]+:/i.test(p.target) ? undefined : p.target }), p.openerId ?? p.callerPaneId)),
    "video.trim": (p) => trimVideo(p.path, p.start, p.end),
    "window.move": (p) => core.windowOps.move(p.id, p.workspaceId),
    "window.follow": (p, { conn } = IN_CORE) => {
      if (!conn) return null;
      core.server.setFollows(conn, p.ids);
      if (conn.access !== "local") core.remote.following(conn, p.ids);
      return null;
    },
  });

// What the core records as it happens because nothing else keeps it (docs/28
// §5): pages browser windows show and files windows open (a window's state only
// holds the current one), windows and Spaces opening and closing, notifications
// shown. Commands are the CommandLog's, hook events the ActivityView's, git the
// journal's sync. Listens to the services' emitters, not the core's broadcast.

import path from "node:path";
import type { AppNotification, AppWindow, Space } from "@cmd/protocol";
import { HOME_SPACE_ID } from "@cmd/protocol";
import { projectOf } from "../journal/backfill.ts";
import type { NotificationCenter } from "../notifications.ts";
import type { SpaceManager } from "../spaces/manager.ts";
import type { WindowManager } from "../windows/manager.ts";
import type { DataService } from "./service.ts";
import { describeSpace, describeWindow } from "./describe.ts";

/** A page seen again within this long is the same visit (its title arrives after its URL). */
const VISIT_MS = 30 * 60_000;
const FILE_KINDS = new Set(["text", "markdown", "pdf", "files"]);

export function recordWindows(data: DataService, windows: WindowManager): void {
  const seen = new Set<string>();
  const closed = new Map<string, AppWindow>();
  windows.on("updated", (w: AppWindow) => {
    const now = Date.now();
    describeWindow(data, w);
    closed.set(w.id, w);
    if (!seen.has(w.id)) {
      seen.add(w.id);
      data.record({ id: `window:${w.id}:open`, at: w.createdAt || now, type: "window.open", source: "window", spaceId: w.spaceId, windowId: w.id, text: w.title || w.kind, data: { kind: w.kind, title: w.title } });
    }
    if (w.kind === "browser" && typeof w.state.url === "string" && /^https?:/.test(w.state.url)) {
      const url = w.state.url;
      const title = w.title && w.title !== url && w.title !== "Browser" ? w.title : null;
      data.record({ id: `visit:${w.id}:${url}:${Math.floor(now / VISIT_MS)}`, at: now, type: "browser.visit", source: "window", spaceId: w.spaceId, windowId: w.id, text: title ?? url, body: title, data: { url, title } });
    } else if (FILE_KINDS.has(w.kind) && typeof w.state.path === "string") {
      const p = w.state.path;
      const dir = w.kind === "files" ? p : path.dirname(p);
      data.record({ id: `file:${w.id}:${p}`, at: now, type: "file.open", source: "window", spaceId: w.spaceId, windowId: w.id, projectId: `dir:${projectOf(dir) ?? dir}`, text: p, data: { path: p, windowKind: w.kind } });
    }
  });
  windows.on("removed", (id: string) => {
    const w = closed.get(id);
    closed.delete(id);
    seen.delete(id);
    if (w) data.record({ id: `window:${id}:close:${Date.now()}`, at: Date.now(), type: "window.close", source: "window", spaceId: w.spaceId, windowId: id, text: w.title || w.kind, data: { kind: w.kind, title: w.title } });
  });
}

export function recordSpaces(data: DataService, spaces: SpaceManager): void {
  const known = new Map<string, Space>();
  for (const s of spaces.list()) known.set(s.id, s), describeSpace(data, s);
  spaces.on("updated", (s: Space) => {
    describeSpace(data, s);
    const first = !known.has(s.id);
    known.set(s.id, s);
    if (first && s.id !== HOME_SPACE_ID) data.record({ id: `space:${s.id}:open:${Date.now()}`, at: Date.now(), type: "space.open", source: "user", spaceId: s.id, projectId: `dir:${projectOf(s.root) ?? s.root}`, text: s.name, data: { name: s.name, root: s.root } });
  });
  spaces.on("removed", (id: string) => {
    const s = known.get(id);
    known.delete(id);
    if (s) data.record({ id: `space:${id}:close:${Date.now()}`, at: Date.now(), type: "space.close", source: "user", spaceId: id, projectId: `dir:${projectOf(s.root) ?? s.root}`, text: s.name, data: { name: s.name, root: s.root } });
  });
}

export function recordNotifications(data: DataService, center: NotificationCenter): void {
  center.on("notification", (n: AppNotification) => {
    data.record({ id: `notification:${n.id}`, at: n.at, type: "notification", source: "cmd", paneId: n.paneId, windowId: n.windowId ?? null, text: n.title, body: n.body, data: { source: n.source, title: n.title, body: n.body, urgent: n.urgent, alert: n.alert } });
  });
}

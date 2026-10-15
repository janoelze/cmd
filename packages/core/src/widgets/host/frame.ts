// Frame widgets (docs/56, "The frame surface, for pixels"): a package widget with
// `"surface": "frame"` draws its view.html in the app's one frame host (renderer lib/frames.ts,
// served by main's cmd-widget://package/). The core says what a frame may load (its package
// folder, the hosts its grant reaches: source) and serves the page's `cmd`: every verb of the
// API (call) and every live topic (subscribe), through its window's own API (the adapter the
// host keeps for the window, api/adapter.ts), so a frame has the grants, scope, rate limits and
// AI budget of its widget's process and never more; secrets stay in the core as they do for
// the process. A verb that needs a press takes the frame's own (press.ts FramePress: the app's
// gesture rule saw one, at most one a second), never the process's. A subscription is the
// process's (api/topics.ts) with its pushes going to the app connection that asked, as
// widget.frameEvent, until it is stopped, the frame goes (widget.frameUnsubscribe with no
// sub), the connection closes, or the window's API ends (a stop, a restart, a grant change,
// the window closed: `ended`, which tells the frame).

import fs from "node:fs";
import { needsPress, type ApiError, type CoreEvent, type WidgetFrameResult, type WindowId, type WireValue } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { Connection } from "../../kernel/connection.ts";
import { ApiRefusal, failed } from "../api/access.ts";
import type { WidgetApi } from "../api/adapter.ts";
import { effective, needsGrant, type Grants } from "../grants.ts";
import type { PackageWidget, WidgetPackage } from "../package.ts";
import type { WidgetPackages } from "../packages.ts";
import { FramePress } from "./press.ts";

const log = logger("widgets");

/** Live subscriptions one connection may hold for one window's frames. */
export const FRAME_SUBS_MAX = 64;

export interface FramesDeps {
  /** The board's windows other than terminals (the frame widget's window among them). */
  windows(): { id: WindowId; kind: string }[];
  packages: Pick<WidgetPackages, "forKind">;
  granted(name: string): Grants | null;
  /** The window's API while its widget may use it (host.ts), or null. */
  api(windowId: WindowId): WidgetApi | null;
  /** One event to one connection (the app's that asked). */
  send(conn: Connection, e: CoreEvent): void;
}

interface Sub {
  conn: Connection;
  windowId: WindowId;
  frame: string;
  sub: number;
  off: () => void;
}

const key = (...parts: (string | number)[]) => parts.join("\n");
const refusal = (e: unknown): WidgetFrameResult => ({ ok: false, error: e instanceof ApiRefusal ? e.error : { code: "failed", message: (e as Error).message.slice(0, 500) } });

export class WidgetFrames {
  #d: FramesDeps;
  /** By connection, then by window, frame and sub. */
  #subs = new Map<Connection, Map<string, Sub>>();
  /** Each frame's presses, by window and frame. */
  #presses = new Map<string, FramePress>();

  constructor(d: FramesDeps) {
    this.#d = d;
  }

  /** The frame widget a window shows, with its grant; null for any other window, or one waiting for its grant. */
  #frameOf(windowId: WindowId): { pkg: WidgetPackage; widget: PackageWidget; net: string[] } | null {
    const w = this.#d.windows().find((x) => x.id === windowId);
    const pkg = w ? this.#d.packages.forKind(w.kind) : null;
    const widget = pkg?.widgets.find((x) => x.kind === w!.kind);
    if (!pkg || !widget || widget.surface !== "frame") return null;
    const g = this.#d.granted(pkg.name);
    if (needsGrant(pkg.permissions, g?.permissions)) return null;
    return { pkg, widget, net: effective(pkg.permissions, g?.permissions).net };
  }

  /** What the window's frame loads: its package folder (real path) and the hosts its grant reaches; null before the grant. */
  source(windowId: WindowId): { dir: string; media: string[] } | null {
    const f = this.#frameOf(windowId);
    if (!f) return null;
    let dir = f.pkg.dir;
    try {
      dir = fs.realpathSync(dir);
    } catch {}
    return { dir, media: f.net };
  }

  /** The window's API for a frame's call or subscription; throws for a window that isn't a frame widget's. */
  #api(windowId: WindowId): WidgetApi {
    if (!this.#frameOf(windowId)) throw new Error(`not a frame widget's window: ${windowId}`);
    const api = this.#d.api(windowId);
    if (!api) throw failed("This widget isn't running.");
    return api;
  }

  /** A verb from a frame; `pressed`: the app's gesture rule saw a press in it, honoured for a verb that needs one. */
  async call(windowId: WindowId, frame: string, verb: string, params: unknown, pressed: boolean): Promise<WidgetFrameResult> {
    const api = this.#api(windowId);
    const k = key(windowId, frame);
    let presses = this.#presses.get(k);
    if (!presses) this.#presses.set(k, (presses = new FramePress()));
    const press = presses.forCall(pressed && needsPress(String(verb)));
    try {
      return { ok: true, value: await api.call(String(verb), (Array.isArray(params) ? params : []) as WireValue[], press) };
    } catch (e) {
      if (!(e instanceof ApiRefusal)) log.warn(`a frame's ${String(verb).slice(0, 60)} failed`, { window: windowId, error: (e as Error).message });
      return refusal(e);
    }
  }

  /** A live topic for a frame, pushed to `conn` (the app connection that asked). */
  subscribe(conn: Connection, windowId: WindowId, frame: string, sub: number, topic: string, query: unknown): WidgetFrameResult {
    const api = this.#api(windowId);
    if (!Number.isInteger(sub) || typeof frame !== "string" || !frame) throw new Error("a frame's subscription names its frame and a number");
    let mine = this.#subs.get(conn);
    if (!mine) this.#subs.set(conn, (mine = new Map()));
    const k = key(windowId, frame, sub);
    mine.get(k)?.off();
    mine.delete(k);
    if ([...mine.values()].filter((s) => s.windowId === windowId).length >= FRAME_SUBS_MAX) return { ok: false, error: { code: "failed", message: `A frame keeps at most ${FRAME_SUBS_MAX} subscriptions; stop one first.` } };
    let live = true;
    try {
      const off = api.subscribe(String(topic), query, (data) => live && this.#d.send(conn, { type: "widget.frameEvent", windowId, frame, sub, data }));
      mine.set(k, { conn, windowId, frame, sub, off: () => ((live = false), off()) });
      return { ok: true, value: null };
    } catch (e) {
      return refusal(e);
    }
  }

  /** Stop one of a frame's subscriptions, or with no `sub` every one of it (the frame is gone). */
  unsubscribe(conn: Connection, windowId: WindowId, frame: string, sub?: number): void {
    const mine = this.#subs.get(conn);
    for (const [k, s] of mine ?? []) {
      if (s.windowId !== windowId || s.frame !== frame || (sub !== undefined && s.sub !== sub)) continue;
      s.off();
      mine!.delete(k);
    }
    if (sub === undefined) this.#presses.delete(key(windowId, frame));
  }

  /** A connection closed: its frames' subscriptions go with it. */
  closed(conn: Connection): void {
    for (const s of this.#subs.get(conn)?.values() ?? []) s.off();
    this.#subs.delete(conn);
  }

  /** The window's API ended (its widget stopped or restarts, its grant changed, its window closed): its frames' subscriptions end, and each frame is told why. */
  ended(windowId: WindowId, why: ApiError = { code: "failed", message: "This widget stopped." }): void {
    for (const mine of this.#subs.values())
      for (const [k, s] of mine) {
        if (s.windowId !== windowId) continue;
        s.off();
        mine.delete(k);
        this.#d.send(s.conn, { type: "widget.frameEvent", windowId, frame: s.frame, sub: s.sub, end: why });
      }
    for (const k of this.#presses.keys()) if (k.startsWith(`${windowId}\n`)) this.#presses.delete(k);
  }

  /** Live subscriptions (tests). */
  count(): number {
    let n = 0;
    for (const m of this.#subs.values()) n += m.size;
    return n;
  }
}

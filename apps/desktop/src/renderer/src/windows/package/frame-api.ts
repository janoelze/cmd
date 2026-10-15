// A frame's widget API in the app (docs/56, "The frame surface"): what a frame widget's page
// asks through its `cmd` (package-frame/frame.js) goes to the core as the window's (widget.frame,
// widget.frameSubscribe), under an id of its own for each page load, so the core keeps its
// presses and subscriptions apart from any other frame's. The app only routes: the core checks
// the widget's grant, scope and limits for every call, as it does for the widget's process. A
// call that needs a press (protocol needsPress: the acts, windows.open) is marked pressed only
// when the frame host's Gesture gave one (lib/frames.ts `wantsPress`). Subscriptions' values come
// back as widget.frameEvent to this connection and go to the page that asked, until it stops
// them, the page goes (close) or the core ends them (the widget stopped).

import { needsPress, type CoreEvent, type WidgetFrameResult, type WindowId } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import type { FrameMessage } from "../../lib/frames.ts";

/** One page load's API: its messages in, its answers and events out. */
export interface FrameApi {
  /** Whether a message may spend a press (lib/frames.ts `wantsPress`). */
  wantsPress(m: FrameMessage): boolean;
  /** A message from the page: true when it was the API's (a call or a subscription). */
  message(m: FrameMessage, pressed: boolean): boolean;
  /** The page is gone (unmounted, or loading again): its subscriptions stop. */
  close(): void;
}

interface Session {
  windowId: WindowId;
  subs: Set<number>;
  post(m: unknown): void;
}

const sessions = new Map<string, Session>();
cmd.onEvent((e) => e.type === "widget.frameEvent" && route(e));

/** The verb names the core takes (frame.js says them as "namespace.name"). */
const VERB = /^\w{1,40}\.\w{1,40}$/;

const failed = (e: Error): WidgetFrameResult => ({ ok: false, error: { code: "failed", message: e.message.slice(0, 500) } });

/** The API for one page load of a frame in `windowId`'s window; `post` sends the page a message. */
export function openFrameApi(windowId: WindowId, post: (m: unknown) => void): FrameApi {
  const frame = crypto.randomUUID();
  const subs = new Set<number>();
  let closed = false;
  const send = (m: unknown) => void (!closed && post(m));
  sessions.set(frame, { windowId, subs, post: send });
  return {
    wantsPress: (m) => m.type === "call" && typeof m.verb === "string" && needsPress(m.verb),
    message(m, pressed) {
      if (closed) return false;
      if (m.type === "call" && Number.isInteger(m.id) && typeof m.verb === "string" && VERB.test(m.verb)) {
        const params = Array.isArray(m.params) ? m.params : [];
        void cmd
          .call("widget.frame", { windowId, frame, verb: m.verb, params, ...(pressed ? { pressed: true } : {}) })
          .catch(failed)
          .then((r) => send({ type: "result", id: m.id, ...r }));
        return true;
      }
      if (m.type === "subscribe" && Number.isInteger(m.sub) && typeof m.topic === "string") {
        const sub = m.sub as number;
        subs.add(sub);
        void cmd
          .call("widget.frameSubscribe", { windowId, frame, sub, topic: m.topic.slice(0, 40), ...(m.query == null ? {} : { query: m.query }) })
          .catch(failed)
          .then((r) => {
            if (r.ok || !subs.delete(sub)) return;
            send({ type: "end", sub, error: r.error });
          });
        return true;
      }
      if (m.type === "unsubscribe" && Number.isInteger(m.sub)) {
        if (subs.delete(m.sub as number)) void cmd.call("widget.frameUnsubscribe", { windowId, frame, sub: m.sub as number }).catch(() => {});
        return true;
      }
      return false;
    },
    close() {
      if (closed) return;
      closed = true;
      sessions.delete(frame);
      if (subs.size) void cmd.call("widget.frameUnsubscribe", { windowId, frame }).catch(() => {});
      subs.clear();
    },
  };
}

/** A subscription's value (or its end) to the page that asked for it. */
function route(e: Extract<CoreEvent, { type: "widget.frameEvent" }>): void {
  const s = sessions.get(e.frame);
  if (!s || s.windowId !== e.windowId || !s.subs.has(e.sub)) return;
  if (!e.end) return s.post({ type: "event", sub: e.sub, data: e.data ?? null });
  s.subs.delete(e.sub);
  s.post({ type: "end", sub: e.sub, error: e.end });
}

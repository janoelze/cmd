// A frame's widget API in the app (windows/package/frame-api.ts): calls go to the core under the
// page load's own frame id, `pressed` only when the Gesture gave a press; a subscription the core
// ends (the window's API replaced: a restart) is asked for again under the same id, so the page's
// live data goes on, and the page hears the end only when asking again is refused too.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent } from "@cmd/protocol";

const calls: { method: string; params: Record<string, unknown> }[] = [];
let answer: (method: string) => unknown = () => ({ ok: true, value: null });
const listeners: ((e: CoreEvent) => void)[] = [];
vi.mock("../src/renderer/src/lib/bridge.ts", () => ({
  cmd: {
    call: (method: string, params: Record<string, unknown>) => (calls.push({ method, params }), Promise.resolve(answer(method))),
    onEvent: (fn: (e: CoreEvent) => void) => (listeners.push(fn), () => {}),
  },
}));
const { openFrameApi } = await import("../src/renderer/src/windows/package/frame-api.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));
const emit = (e: CoreEvent) => listeners.forEach((fn) => fn(e));

beforeEach(() => {
  calls.length = 0;
  answer = () => ({ ok: true, value: null });
});

describe("a frame's API in the app", () => {
  it("sends calls under its frame, pressed only with a press, and answers the page", async () => {
    const posted: unknown[] = [];
    const api = openFrameApi("w1", (m) => posted.push(m));
    expect(api.wantsPress({ type: "call", verb: "windows.open" })).toBe(true);
    expect(api.wantsPress({ type: "call", verb: "agents.list" })).toBe(false);
    expect(api.message({ type: "call", id: 1, verb: "agents.list", params: [] }, false)).toBe(true);
    expect(api.message({ type: "call", id: 2, verb: "bad verb!", params: [] }, true)).toBe(false);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toMatchObject({ windowId: "w1", verb: "agents.list", params: [] });
    expect(calls[0]!.params.pressed).toBeUndefined();
    expect(posted).toEqual([{ type: "result", id: 1, ok: true, value: null }]);
    api.close();
  });

  it("asks again for a subscription the core ended, under the same id, and tells the page only when that is refused", async () => {
    const posted: { type: string; sub?: number }[] = [];
    const api = openFrameApi("w1", (m) => posted.push(m as { type: string }));
    api.message({ type: "subscribe", sub: 7, topic: "agents", query: { scope: "all" } }, false);
    await tick();
    const frame = calls[0]!.params.frame as string;
    // The core ends it (a restart): asked for again, the page doesn't notice, and its values go on.
    emit({ type: "widget.frameEvent", windowId: "w1", frame, sub: 7, end: { code: "failed", message: "This widget stopped, so its live data did too." } });
    await tick();
    expect(calls.map((c) => c.method)).toEqual(["widget.frameSubscribe", "widget.frameSubscribe"]);
    expect(calls[1]!.params).toMatchObject({ windowId: "w1", frame, sub: 7, topic: "agents", query: { scope: "all" } });
    emit({ type: "widget.frameEvent", windowId: "w1", frame, sub: 7, data: [1] });
    expect(posted).toEqual([{ type: "event", sub: 7, data: [1] }]);
    // Ended for good (the window closed): asked again, refused, and the page is told.
    answer = () => ({ ok: false, error: { code: "failed", message: "This widget isn't running. Restart it from its window." } });
    emit({ type: "widget.frameEvent", windowId: "w1", frame, sub: 7, end: { code: "failed", message: "This widget's window is closed." } });
    await tick();
    expect(posted.at(-1)).toEqual({ type: "end", sub: 7, error: { code: "failed", message: "This widget's window is closed." } });
    emit({ type: "widget.frameEvent", windowId: "w1", frame, sub: 7, data: [2] });
    expect(posted.filter((m) => m.type === "event")).toHaveLength(1);
    api.close();
  });
});

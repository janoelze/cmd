import { describe, expect, it } from "vitest";
import { DONE_BATCH_MS, DONE_TAG, DoneBatch, Looks, SAW_IT_MS } from "../src/renderer/src/notify.ts";

describe("looks", () => {
  it("count what you look at now and what you looked away from just before", () => {
    const l = new Looks();
    l.look("a", 1000);
    expect(l.saw("a", 5000)).toBe(true);
    l.look("b", 10_000);
    expect(l.saw("a", 10_000 + SAW_IT_MS)).toBe(true);
    expect(l.saw("a", 10_001 + SAW_IT_MS)).toBe(false);
    expect(l.saw("c", 10_000)).toBe(false);
  });

  it("stop when the app loses focus", () => {
    const l = new Looks();
    l.look("a", 0);
    l.look(null, 1000);
    expect(l.now("a")).toBe(false);
    expect(l.saw("a", 1000 + SAW_IT_MS + 1)).toBe(false);
  });
});

describe("agents that finish close together", () => {
  const done = (tag: string, name: string, at: number) => ({ tag, name, title: `${name} · done`, body: `${name} body`, at });

  it("share one notification that replaces theirs", () => {
    const b = new DoneBatch();
    expect(b.add(done("p1", "cmd-dnd", 0))).toEqual({ tag: "p1", title: "cmd-dnd · done", body: "cmd-dnd body", replaces: [] });
    expect(b.add(done("p2", "cmd-sheets", 60_000))).toEqual({ tag: DONE_TAG, title: "2 agents · done", body: "cmd-sheets and cmd-dnd", replaces: ["p1"] });
    expect(b.add(done("p3", "cmd-journal", 90_000))).toMatchObject({ title: "3 agents · done", body: "cmd-journal, cmd-sheets and cmd-dnd" });
    expect(b.add(done("p4", "web", 100_000)).body).toBe("web, cmd-journal, cmd-sheets and 1 more");
  });

  it("start over after a quiet spell, and leave out what you looked at", () => {
    const b = new DoneBatch();
    b.add(done("p1", "a", 0));
    expect(b.add(done("p2", "b", DONE_BATCH_MS + 1)).tag).toBe("p2");
    b.seen("p2");
    expect(b.add(done("p3", "c", DONE_BATCH_MS + 2)).tag).toBe("p3");
  });

  it("count an agent that finishes twice once", () => {
    const b = new DoneBatch();
    b.add(done("p1", "a", 0));
    expect(b.add(done("p1", "a", 1000)).tag).toBe("p1");
  });
});

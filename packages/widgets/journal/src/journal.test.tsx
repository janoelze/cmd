// Work Log against the fake host (@cmd/widget-api/testing): the native Journal's days, read
// only. Days newest first with their headline, hours and ribbon; entries newest first with
// their kind, outcome, summary and counts; a bar of the ribbon rings its entry; when the newest
// day was written; it reads again on a timer and from Read Again on the newest day's heading (no
// title menu, as the native Journal's Write Again), never asking for a day to
// be written; loading, empty, refused, failed (and failed after a good read), many days, and a
// cmd before API 1.2.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, createHost, fixtures, type FakeHost } from "@cmd/widget-api/testing";
import WorkLog, { DAYS, EVERY, countsText, dayName, ribbonOf, span } from "./journal.tsx";

// A fixed clock (only Date, and the timers a test asks for): today at noon, so "Today", the
// hours written and the journal's 04:00 day turn read the same at any hour the tests run.
const NOON = new Date(2026, 9, 15, 12, 0, 0);
const fixedClock = (...timers: ("setInterval" | "clearInterval")[]) => vi.useFakeTimers({ now: NOON, toFake: ["Date", ...timers] });
fixedClock();
beforeEach(() => void fixedClock());
afterAll(() => void vi.useRealTimers());

const { day } = fixtures;
const H = 3_600_000;
const today = new Date(Date.now() - 4 * H).setHours(0, 0, 0, 0);
const yesterday = new Date(today - 12 * H).setHours(0, 0, 0, 0);

const days = [
  day({
    date: today,
    headline: "Ported three widgets to packages",
    writtenAt: today + 15 * H,
    entries: [
      { id: "a", kind: "feature", title: "Ported the Journal", outcome: "merged", start: today + 9 * H, end: today + 11 * H, counts: { agents: 2, prompts: 5, commands: 4, commits: 1, pages: 0, files: 6 } },
      { id: "b", kind: "fix", title: "Fixed the footer", outcome: null, summary: "", start: today + 13 * H, end: today + 13.5 * H },
    ],
  }),
  day({ date: yesterday, headline: "Released v0.31", entries: [{ id: "c", kind: "release", title: "Released v0.31", outcome: "shipped" }] }),
];

/** A host whose answers to `method` are held until `release()`: the widget waits as it would for a slow core. */
function holding(host: FakeHost, method: string) {
  const held: Parameters<FakeHost["transport"]["send"]>[0][] = [];
  const h = Object.create(host) as FakeHost;
  Object.defineProperty(h, "transport", {
    value: { listen: host.transport.listen, send: (m: (typeof held)[number]) => (m.kind === "call" && m.method === method ? held.push(m) : host.transport.send(m)) },
  });
  return { host: h, release: () => held.splice(0).forEach((m) => host.transport.send(m)) };
}

afterEach(() => vi.useRealTimers());

describe("Work Log", () => {
  it("draws the written days newest first: name, hours, headline, a ribbon of the hours and the entries", async () => {
    const host = createHost({ journal: days });
    const tree = await render(<WorkLog />, host);
    expect(host.requests).toContainEqual(["journal.days", { count: DAYS }]);
    const text = tree.text();
    expect(text.indexOf("Today")).toBeLessThan(text.indexOf("Yesterday"));
    expect(text).toContain("09:00–13:30");
    expect(text).toContain("Ported three widgets to packages");
    const ribbons = tree.findAll("Ribbon");
    expect(ribbons).toHaveLength(2);
    expect((ribbons[0]!.props.items as { id: string; hue: number }[]).map((i) => [i.id, i.hue])).toEqual([["a", 275], ["b", 145]]);
    // Entries newest first, each with its kind on the rail, its outcome and what it took.
    const entries = tree.findAll("TimelineEntry");
    expect(entries.map((e) => [e.props.time, e.props.label])).toEqual([["13:00", "Fix"], ["09:00", "Feature"], ["09:00", "Release"]]);
    expect(tree.findAll("Badge").map((b) => JSON.stringify(b))).toEqual([expect.stringContaining("Merged"), expect.stringContaining("Shipped")]);
    expect(text).toContain("2 h · 2 agents · 4 commands · 1 commit · 6 files");
    expect(tree.find("StatusLine")).toBeTruthy();
    expect(tree.text()).toContain("Written at 15:00");
  });

  it("rings an entry when its bar in the ribbon is picked, and lets go on a second pick", async () => {
    const tree = await render(<WorkLog />, createHost({ journal: days }));
    await tree.pick(tree.findAll("Ribbon")[0]!, "a");
    expect(tree.findAll("Ribbon")[0]!.props.picked).toBe("a");
    expect(tree.findAll("TimelineEntry").filter((e) => e.props.picked).map((e) => e.props.label)).toEqual(["Feature"]);
    await tree.pick(tree.findAll("Ribbon")[0]!, "a");
    expect(tree.findAll("TimelineEntry").some((e) => e.props.picked)).toBe(false);
  });

  it("reads again every few minutes and from Read Again on the newest day's heading, and never asks for a day to be written", async () => {
    fixedClock("setInterval", "clearInterval");
    const host = createHost({ journal: [] });
    const tree = await render(<WorkLog />, host);
    expect(tree).toShowState("empty", "Nothing written yet");
    host.set({ journal: days });
    vi.advanceTimersByTime(EVERY * 1000);
    await tree.idle();
    expect(tree.text()).toContain("Released v0.31");
    expect(tree.find("Window").props.menu).toBeUndefined();
    // One button, on the newest day's heading.
    expect(tree.findAll("IconButton", (b) => b.props.label === "Read Again")).toHaveLength(1);
    expect(JSON.stringify(tree.find("Inline", (n) => n.props.justify === "between"))).toContain(`"Read Again"`);
    await tree.press(tree.find("IconButton", (b) => b.props.label === "Read Again"));
    expect(host.requests.filter((r) => r[0] === "journal.days")).toHaveLength(3);
    expect(host.requests.every((r) => r[0] !== "journal.days" || JSON.stringify(r[1]) === JSON.stringify({ count: DAYS }))).toBe(true);
    expect(host.calls).toEqual([]);
  });

  it("says it is reading while the first answer is on its way", async () => {
    const { host, release } = holding(createHost({ journal: days }), "journal.days");
    const tree = await render(<WorkLog />, host);
    expect(tree).toShowState("loading", "Reading the journal");
    release();
    await tree.idle();
    expect(tree.text()).toContain("Ported three widgets to packages");
  });

  it("says what goes here when nothing is written", async () => {
    const tree = await render(<WorkLog />, createHost({ journal: [] }));
    expect(tree).toShowState("empty", "Nothing written yet");
    expect(tree.findAll("StatusLine")).toHaveLength(0);
  });

  it("says what it needs when the journal is refused", async () => {
    const tree = await render(<WorkLog />, createHost({ journal: days, deny: { "journal.days": 'events: ["agents"]' } }));
    expect(tree).toShowState("error", "The journal isn't shared with this widget");
    expect(JSON.stringify(tree.find("View").props.state)).toContain('events: [\\"agents\\"]');
  });

  it("says it couldn't read the journal, with Try Again; after a good read it keeps the days and says so below", async () => {
    let fail = true;
    const host = createHost({ journal: days });
    const { host: flaky } = { host: Object.create(host) as FakeHost };
    Object.defineProperty(flaky, "transport", {
      value: {
        listen: host.transport.listen,
        send: (m: Parameters<FakeHost["transport"]["send"]>[0]) => (fail && m.kind === "call" && m.method === "journal.days" ? host.deliver({ kind: "result", id: m.id, ok: false, error: { code: "failed", message: "The journal is busy." } }) : host.transport.send(m)),
      },
    });
    const tree = await render(<WorkLog />, flaky);
    expect(tree).toShowState("error", "Couldn't read the journal");
    fail = false;
    await tree.choose(tree.find("View"), "Try Again", "state");
    expect(tree.text()).toContain("Released v0.31");
    fail = true;
    await tree.press(tree.find("IconButton", (b) => b.props.label === "Read Again"));
    expect(tree.text()).toContain("Released v0.31");
    expect(tree.text()).toContain("Couldn't read the journal again");
  });

  it("draws many days with many entries", async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      day({ date: new Date(today - i * 24 * H).setHours(0, 0, 0, 0), headline: `Day ${i}`, entries: Array.from({ length: 9 }, (_, j) => ({ id: `${i}-${j}`, kind: (["feature", "fix", "review", "research"] as const)[j % 4]!, title: `Entry ${j}`, start: today - i * 24 * H + (5 + j * 2) * H, end: today - i * 24 * H + (6 + j * 2) * H })) }),
    );
    const tree = await render(<WorkLog />, createHost({ journal: many }));
    expect(tree.findAll("Ribbon")).toHaveLength(7);
    expect(tree.findAll("TimelineEntry")).toHaveLength(63);
    // 05:00 to 22:00: past 8 hours, a tick every other hour.
    expect((tree.findAll("Ribbon")[0]!.props.ticks as unknown[]).length).toBe(9);
  });

  it("says it needs a newer cmd on one before API 1.2, and asks nothing", async () => {
    const older = createHost({ env: { api: { major: 1, minor: 1 }, verbs: ["events.query"], elements: undefined }, journal: days });
    const tree = await render(<WorkLog />, older);
    expect(tree).toShowState("empty", "Needs a newer cmd");
    expect(older.requests.some((r) => r[0] === "journal.days")).toBe(false);
  });

  it("names days, spans and counts as the Journal does", () => {
    const now = today + 10 * H;
    expect(dayName(today, now)).toBe("Today");
    expect(dayName(yesterday, now)).toBe("Yesterday");
    expect(dayName(today, today + 26 * H)).toBe("Today"); // 02:00 the next night still belongs to the work day
    expect(dayName(today, today + 30 * H)).toBe("Yesterday");
    expect(span(40 * 60_000)).toBe("40 min");
    expect(span(125 * 60_000)).toBe("2 h 5 min");
    expect(countsText({ agents: 1, prompts: 9, commands: 0, commits: 2, pages: 0, files: 0 })).toBe("1 agent · 2 commits");
    const r = ribbonOf(days[0]!);
    expect([r.from, r.to]).toEqual([today + 9 * H, today + 14 * H]);
    expect(r.ticks.map((t) => t.label)).toEqual(["09", "10", "11", "12", "13", "14"]);
  });
});

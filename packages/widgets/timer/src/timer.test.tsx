// Countdown against the fake host (@cmd/widget-api/testing), with a fake clock: the native
// Timer's job. It starts set at 25 minutes; Start keeps when it ends in the window's state; it
// rings through cmd.notify at the end, on time to the second, once, and says it's done; Pause
// keeps what's left; a typed length sets it; one that ended while nothing ran rings once, late.
// (Its process runs while its window is open in any workspace: widget-host.test.ts.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, createHost } from "@cmd/widget-api/testing";
import Countdown, { clock, durationLabel, parseDuration, type Timer } from "./timer.tsx";

const notes = (host: ReturnType<typeof createHost>) => host.calls.filter((c) => c[0] === "notify.send");
const button = (label: string) => (n: { props: Record<string, unknown> }) => n.props.label === label;

describe("Countdown", () => {
  beforeEach(() => void vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(2026, 9, 15, 14, 0, 0) }));
  afterEach(() => void vi.useRealTimers());

  it("starts set at 25 minutes, with the presets", async () => {
    const tree = await render(<Countdown />, createHost());
    expect(tree.text()).toContain("25:00");
    expect(tree.find("ToolbarSegmented").props.value).toBe("25");
    expect(tree.find("Window").props.status).toBeNull();
  });

  it("rings through cmd.notify on time, once, and says it's done", async () => {
    const host = createHost();
    const tree = await render(<Countdown />, host);
    await tree.press(tree.find("ToolbarButton", button("Start")));
    const set = host.requests.filter((r) => r[0] === "state.set" && r[1] === "timer").at(-1)?.[2] as Timer;
    expect(set.endsAt! - Date.now()).toBeGreaterThan(25 * 60_000 - 1000);
    expect(set.endsAt! - Date.now()).toBeLessThanOrEqual(25 * 60_000);
    expect(tree.find("Window").props.status).toBe("ends 14:25");

    vi.advanceTimersByTime(set.endsAt! - Date.now() - 1500);
    await tree.idle();
    expect(notes(host)).toEqual([]);
    expect(tree.text()).toMatch(/0:0[12]/);
    vi.advanceTimersByTime(1500);
    await tree.idle();
    expect(notes(host)).toEqual([["notify.send", { key: `timer-${set.endsAt}`, title: "25 min timer · done", body: "Time's up", urgent: true }]]);
    expect(tree.find("Window").props.status).toBe("done at 14:25");
    expect(tree.find("ToolbarButton", button("Start Again"))).toBeTruthy();
    vi.advanceTimersByTime(60_000);
    await tree.idle();
    expect(notes(host)).toHaveLength(1);
  });

  it("pauses with what's left, and resumes from there", async () => {
    const host = createHost();
    const tree = await render(<Countdown />, host);
    await tree.press(tree.find("ToolbarButton", button("Start")));
    vi.advanceTimersByTime(10 * 60_000);
    await tree.idle();
    await tree.press(tree.find("ToolbarButton", button("Pause")));
    expect(tree.text()).toContain("15:00");
    expect(tree.find("Window").props.status).toBe("paused");
    vi.advanceTimersByTime(60 * 60_000);
    await tree.idle();
    expect(notes(host)).toEqual([]);
    await tree.press(tree.find("ToolbarButton", button("Resume")));
    expect(tree.find("Window").props.status).toBe("ends 15:25");
  });

  it("takes a typed length", async () => {
    const host = createHost();
    const tree = await render(<Countdown />, host);
    await tree.submit(tree.find("ToolbarField"), "1:30");
    expect(tree.text()).toContain("1:30");
    await tree.press(tree.find("ToolbarButton", button("Start")));
    vi.advanceTimersByTime(90_000);
    await tree.idle();
    expect(notes(host)[0]?.[1]).toMatchObject({ title: "1 min 30 s timer · done" });
  });

  it("rings once, late, for one that ended while nothing ran", async () => {
    const endsAt = Date.now() - 5 * 60_000;
    const host = createHost({ state: { timer: { duration: 600, endsAt, left: null, rang: null } } });
    const tree = await render(<Countdown />, host);
    expect(notes(host)).toEqual([["notify.send", expect.objectContaining({ title: "10 min timer · done", body: "Ended at 13:55" })]]);
    expect(tree.find("Window").props.status).toBe("done at 13:55");
  });

  it("reads lengths as people type them", () => {
    expect([parseDuration("10"), parseDuration("1:30"), parseDuration("90s"), parseDuration("1h 30m"), parseDuration("soon")]).toEqual([600, 90, 90, 5400, null]);
    expect([clock(1500), clock(3900), clock(9)]).toEqual(["25:00", "1:05:00", "0:09"]);
    expect(durationLabel(5400)).toBe("1 h 30 min");
  });
});

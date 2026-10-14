// The pomodoro against the fake host: it starts paused, Start keeps the end in the window's
// state, a timer that ran out notifies once and lines up the break.

import { describe, expect, it } from "vitest";
import { render, createHost } from "@cmd/widget-api/testing";
import Pomodoro from "./timer.tsx";

describe("Pomodoro", () => {
  it("starts paused at 25 minutes", async () => {
    const tree = await render(<Pomodoro />, createHost());
    expect(tree.text()).toContain("25:00");
    expect(tree.find("Window").props.status).toBe("Focus · paused");
  });

  it("keeps when it ends in the window's state", async () => {
    const host = createHost();
    const tree = await render(<Pomodoro />, host);
    await tree.press(tree.find("ToolbarButton", (n) => n.props.label === "Start"));
    const set = host.requests.find((r) => r[0] === "state.set" && r[1] === "timer");
    expect((set?.[2] as { endsAt: number }).endsAt).toBeGreaterThan(Date.now());
  });

  it("notifies once at the end and lines up the break", async () => {
    const host = createHost({ state: { timer: { phase: "focus", minutes: 25, endsAt: Date.now() - 1000, left: 0 } } });
    const tree = await render(<Pomodoro />, host);
    expect(host.calls.filter((c) => c[0] === "notify.send")).toEqual([["notify.send", expect.objectContaining({ title: "Time for a break" })]]);
    expect(tree.find("Window").props.status).toBe("Break · paused");
    expect(tree.text()).toContain("5:00");
  });
});

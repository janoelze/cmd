import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { PaneManager } from "../src/panes.ts";
import { fakeFactory } from "./fake-pty.ts";

afterEach(() => vi.useRealTimers());

const setup = () => {
  const f = fakeFactory();
  const panes = new PaneManager(f.factory, { socketPath: "/tmp/test.sock", pollMs: 0, settings: () => ({ ...DEFAULT_SETTINGS, "shell.program": "/bin/zsh" }) });
  const pane = panes.create();
  return { panes, id: pane.id, pty: f.ptys[0]! };
};

describe("progress (OSC 9;4)", () => {
  it("tracks the bar, keeps the value through an error, and clears it", () => {
    const { panes, id, pty } = setup();
    pty.output("\x1b]9;4;1;30\x07");
    expect(panes.get(id)!.progress).toEqual({ state: "normal", value: 30 });
    pty.output("\x1b]9;4;2\x07");
    expect(panes.get(id)!.progress).toEqual({ state: "error", value: 30 });
    pty.output("\x1b]9;4;0\x07");
    expect(panes.get(id)!.progress).toBeNull();
  });

  it("goes away at the next prompt, or when it stops being updated", () => {
    vi.useFakeTimers();
    const { panes, id, pty } = setup();
    pty.output("\x1b]9;4;3\x07");
    expect(panes.get(id)!.progress?.state).toBe("indeterminate");
    pty.output("\x1b]133;A\x07");
    expect(panes.get(id)!.progress).toBeNull();
    pty.output("\x1b]9;4;1;50\x07");
    vi.advanceTimersByTime(14_000);
    expect(panes.get(id)!.progress).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(panes.get(id)!.progress).toBeNull();
  });
});

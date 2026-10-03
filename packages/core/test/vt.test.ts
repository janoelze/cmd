// The core keeps real terminal state per pane; re-attaching UIs get it serialized.
import { describe, expect, it } from "vitest";
import headless from "@xterm/headless";
import { PaneManager } from "../src/panes.ts";
import { fakeFactory } from "./fake-pty.ts";

/** What a UI shows after writing a snapshot into a fresh terminal of the same size. */
async function render(snapshot: string, cols = 40, rows = 6): Promise<{ text: string; mouse: string }> {
  const t = new headless.Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((r) => t.write(snapshot, r));
  const lines: string[] = [];
  for (let i = 0; i < t.buffer.active.length; i++) lines.push(t.buffer.active.getLine(i)!.translateToString(true));
  return { text: lines.join("\n").trimEnd(), mouse: t.modes.mouseTrackingMode };
}

describe("pane terminal state", () => {
  const setup = () => {
    const f = fakeFactory();
    const panes = new PaneManager(f.factory, { socketPath: "/tmp/vt.sock", pollMs: 0 });
    const pane = panes.create({ cols: 40, rows: 6 });
    return { panes, pane, pty: f.ptys[0]! };
  };

  it("restores a redrawing TUI as one frame, not stacked copies", async () => {
    const { panes, pane, pty } = setup();
    pty.output("$ agent\r\n");
    // A TUI redrawing its two-line frame in place, many times (cursor up + clear).
    for (let i = 0; i < 50; i++) pty.output(`${i ? "\x1b[2A\r\x1b[J" : ""}status: step ${i}\r\nprompt >\r\n`);
    const { text } = await render(await panes.snapshot(pane.id));
    expect(text.match(/status:/g)).toHaveLength(1);
    expect(text).toContain("status: step 49");
  });

  it("does not bring back modes a program already turned off", async () => {
    const { panes, pane, pty } = setup();
    pty.output("\x1b[?1000h\x1b[?1006h"); // mouse reporting on…
    pty.output("\x1b[?1000l\x1b[?1006l"); // …and off again
    expect((await render(await panes.snapshot(pane.id))).mouse).toBe("none");
    pty.output("\x1b[?1000h"); // a program that is still running keeps it
    expect((await render(await panes.snapshot(pane.id))).mouse).not.toBe("none");
    await panes.resetState(pane.id);
    expect((await render(await panes.snapshot(pane.id))).mouse).toBe("none");
  });

  it("reads back the displayed text", async () => {
    const { panes, pane, pty } = setup();
    pty.output("one\r\n\x1b[31mtwo\x1b[0m\r\nthree");
    expect(await panes.read(pane.id, 2)).toBe("two\nthree");
  });
});

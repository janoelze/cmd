// The phone's terminal re-attached (opened, or a resync): the core's snapshot replayed,
// the phone's size (it rotated, the keyboard opened) while that is parsed, then the shell's
// redraw for the size the phone told the Mac. The screen must keep every line the core has.
import { describe, expect, it } from "vitest";
import { Screen, type Size } from "../src/screen.ts";
import { APP, CORE, MARKER, ROWS, core, redraw, term, text, write } from "../../../packages/core/test/zsh-replay.ts";

describe("the phone's screen", () => {
  it("holds a resize until the snapshot is parsed, and tells the Mac only then", async () => {
    const { snapshot, screen } = await core();
    expect(screen).toContain(MARKER);
    const t = term(80);
    const s = new Screen(t);
    const told: Size[] = [];
    // Terminal.tsx's apply, fitting: this phone's size, then pane.fitOverride.
    const fit = () => s.resize({ cols: APP, rows: ROWS }, () => told.push({ cols: APP, rows: ROWS }));
    let parsed!: () => void;
    const done = new Promise<void>((r) => (parsed = r));
    s.onParsed = () => (fit(), parsed());
    s.awaitSnapshot();
    s.snapshot({ data: snapshot, cols: CORE, rows: ROWS });
    expect(t.cols).toBe(CORE);
    // The phone rotates while xterm parses: nothing changes, the Mac hears nothing.
    expect(s.busy).toBe(true);
    expect(fit()).toBe(false);
    expect(t.cols).toBe(CORE);
    expect(told).toEqual([]);
    await done;
    expect(s.busy).toBe(false);
    expect(t.cols).toBe(APP);
    expect(told).toEqual([{ cols: APP, rows: ROWS }]);
    // The PTY heard the new size: zsh redraws over its prompt.
    await write(t, redraw);
    expect(text(t)).toBe(screen);
  });

  it("writes output that came before the snapshot after it", async () => {
    const t = term(CORE);
    const s = new Screen(t);
    s.awaitSnapshot();
    s.output("second");
    s.snapshot({ data: "first ", cols: CORE, rows: ROWS });
    s.output(" third");
    await write(t, "");
    expect(text(t)).toBe("first second third");
  });

  it("writes each byte once: what the snapshot shows is skipped, before its reply or after", async () => {
    const t = term(CORE);
    const s = new Screen(t);
    s.awaitSnapshot();
    // "one two " is in the snapshot (seq 8). Some of it arrived before the reply, the rest
    // after it (a remote session holds output for a moment), one event half in it.
    s.output("one ", 4);
    s.output("tw", 6);
    s.snapshot({ data: "one two ", cols: CORE, rows: ROWS, seq: 8 });
    s.output("o three", 13);
    s.output(" four", 18);
    await write(t, "");
    expect(text(t)).toBe("one two three four");
  });
});

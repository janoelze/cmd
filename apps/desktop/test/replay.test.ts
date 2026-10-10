// A re-attached terminal: the core's snapshot replayed into the app's terminal, then the
// app's size, then the shell's redraw for it. The screen must keep every line the core has.
import { describe, expect, it } from "vitest";
import { Replayer } from "@cmd/protocol/replay";
import { APP, CORE, MARKER, ROWS, core, redraw, term, text, write } from "../../../packages/core/test/zsh-replay.ts";

describe("replaying a snapshot", () => {
  it("keeps the output line when the view fits before the snapshot is parsed", async () => {
    const { snapshot, screen } = await core();
    expect(screen).toContain(MARKER);
    const t = term(80);
    const replays = new Replayer(t);
    // Terminals.fit: not while a snapshot is being parsed.
    const fit = () => !replays.busy && t.cols !== APP && t.resize(APP, ROWS);
    let fitted!: () => void;
    const parsed = new Promise<void>((r) => (fitted = r));
    replays.replay(snapshot, { cols: CORE, rows: ROWS }, () => (fit(), fitted()));
    // The view attaches right away and fits (the store releases it after writing).
    expect(replays.busy).toBe(true);
    fit();
    expect(t.cols).toBe(CORE);
    await parsed;
    expect(replays.busy).toBe(false);
    expect(t.cols).toBe(APP);
    // The PTY heard the new size: zsh redraws.
    await write(t, redraw);
    expect(text(t)).toBe(screen);
  });

  it("loses it when resized mid-replay (why replays block fits)", async () => {
    const { snapshot } = await core();
    const t = term(CORE);
    const parsed = write(t, snapshot);
    t.resize(APP, ROWS);
    await parsed;
    await write(t, redraw);
    expect(text(t)).not.toContain(MARKER);
  });
});

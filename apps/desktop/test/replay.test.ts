// A re-attached terminal: the core's snapshot replayed into the app's terminal, then the
// app's size, then the shell's redraw for it. The screen must keep every line the core has.
import { describe, expect, it } from "vitest";
import headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Replayer } from "../src/renderer/src/replay.ts";

type Term = InstanceType<typeof headless.Terminal>;

const ROWS = 20;
const term = (cols: number): Term => new headless.Terminal({ cols, rows: ROWS, scrollback: 1000, allowProposedApi: true });
const write = (t: Term, data: string) => new Promise<void>((r) => t.write(data, r));
const text = (t: Term) => {
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)!.translateToString(true));
  return out.join("\n").trimEnd();
};

// What zsh writes, as captured (macOS zsh 5.9, cmd's shell integration left out): a prompt
// as long as CI's, which wraps in a narrow terminal, PROMPT_SP before each prompt, and on
// SIGWINCH the redraw (up over the prompt's first row, clear below, the prompt again).
const PROMPT = "runner@iad20-eo1208-a5e1efe4-8a22-4d1a-aaa1-569159c3fc25-C6EAA23AB0A0 ~ % ";
const promptSp = (cols: number) => `\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m${" ".repeat(cols - 1)}\r \r`;
const prompt = (cols: number) => `${promptSp(cols)}\r\x1b[0m\x1b[27m\x1b[24m\x1b[J${PROMPT}\x1b[K\x1b[?2004h`;
const session = (cols: number) =>
  prompt(cols) +
  "printf '\\033[?1000h\\033[?1000l'; echo MARKER-$((40+2))\x1b[?2004l\r\r\n" +
  "\x1b[?1000h\x1b[?1000lMARKER-42\r\n" +
  prompt(cols);
const redraw = `\r\r\x1b[A\x1b[0m\x1b[27m\x1b[24m\x1b[J${PROMPT}`;

// The smoke e2e's restart on CI: the core's terminal at 67 columns, the app's 8 wider.
const CORE = 67;
const APP = 75;

/** The core's terminal: the session, the app's size, the redraw. And its snapshot from before the resize. */
async function core(): Promise<{ snapshot: string; screen: string }> {
  const t = term(CORE);
  const serializer = new SerializeAddon();
  t.loadAddon(serializer);
  await write(t, session(CORE));
  const snapshot = serializer.serialize({ scrollback: 1000 });
  t.resize(APP, ROWS);
  await write(t, redraw);
  return { snapshot, screen: text(t) };
}

describe("replaying a snapshot", () => {
  it("keeps the output line when the view fits before the snapshot is parsed", async () => {
    const { snapshot, screen } = await core();
    expect(screen).toContain("MARKER-42");
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
    expect(text(t)).not.toContain("MARKER-42");
  });
});

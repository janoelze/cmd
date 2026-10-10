// Recorded zsh bytes for snapshot-replay tests (the app's replay.test.ts, the web client's
// screen.test.ts): a session whose prompt wraps in a narrow terminal, and the redraw zsh
// writes when the terminal is resized. The core's terminal is the reference: a client that
// replays its snapshot, resizes, and then gets the redraw must show the same screen.
import headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

export type Term = InstanceType<typeof headless.Terminal>;

export const ROWS = 20;
export const term = (cols: number): Term => new headless.Terminal({ cols, rows: ROWS, scrollback: 1000, allowProposedApi: true });
export const write = (t: Term, data: string) => new Promise<void>((r) => t.write(data, r));
export const text = (t: Term) => {
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
/** The output line the redraw must not wipe. */
export const MARKER = "MARKER-42";
export const redraw = `\r\r\x1b[A\x1b[0m\x1b[27m\x1b[24m\x1b[J${PROMPT}`;

// The smoke e2e's restart on CI: the core's terminal at 67 columns, the client's 8 wider.
export const CORE = 67;
export const APP = 75;

/** The core's terminal: the session, the client's size, the redraw. And its snapshot from before the resize. */
export async function core(): Promise<{ snapshot: string; screen: string }> {
  const t = term(CORE);
  const serializer = new SerializeAddon();
  t.loadAddon(serializer);
  await write(t, session(CORE));
  const snapshot = serializer.serialize({ scrollback: 1000 });
  t.resize(APP, ROWS);
  await write(t, redraw);
  return { snapshot, screen: text(t) };
}

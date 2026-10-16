// What the phone types into a Mac terminal, and what it reads out of one, without the
// DOM: the key row's keys and its sticky modifiers, arrows that repeat while held, the
// compose bar's text-then-Return, and the links and words under a finger (Terminal.tsx
// and viewport.ts draw and wire them).

/** The key row after its ctrl and alt toggles. `repeat`: held, it types again and again. */
export const KEYS: { label: string; data: string; name?: string; repeat?: boolean }[] = [
  { label: "esc", data: "\x1b" },
  { label: "tab", data: "\t" },
  { label: "⇧tab", data: "\x1b[Z", name: "Shift Tab" },
  { label: "↑", data: "\x1b[A", name: "Up", repeat: true },
  { label: "↓", data: "\x1b[B", name: "Down", repeat: true },
  { label: "←", data: "\x1b[D", name: "Left", repeat: true },
  { label: "→", data: "\x1b[C", name: "Right", repeat: true },
  { label: "^C", data: "\x03" },
  { label: "|", data: "|" },
  { label: "~", data: "~" },
  { label: "/", data: "/" },
  { label: "-", data: "-" },
  { label: "⏎", data: "\r", name: "Return" },
];

/** ctrl + a key: its control character (ctrl-c → \x03), else the key as is. */
export function withCtrl(data: string): string {
  const c = data[0];
  if (!c || data.length !== 1) return data;
  const code = c.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (c === " ") return "\x00";
  if (c === "?") return "\x7f";
  return data;
}

/** alt (meta) + a key: ESC before it, as macOS terminals send with Option as Meta (alt-b: back a word). */
export const withAlt = (data: string): string => (data ? `\x1b${data}` : data);

/** The sticky modifiers on what's typed next: ctrl first (alt-ctrl-x is ESC ^X). */
export function modified(data: string, mods: { ctrl: boolean; alt: boolean }): string {
  let d = mods.ctrl ? withCtrl(data) : data;
  if (mods.alt) d = withAlt(d);
  return d;
}

/** How long a key is held before it repeats, and how often then (macOS's defaults, roughly). */
export const REPEAT_DELAY = 400;
export const REPEAT_EVERY = 60;

/**
 * A held key: `press` types once, and again every REPEAT_EVERY ms after REPEAT_DELAY,
 * until `release` (finger up, cancelled, or slid off).
 */
export class Repeater {
  #send: (data: string) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(send: (data: string) => void) {
    this.#send = send;
  }

  press(data: string): void {
    this.release();
    this.#send(data);
    const again = () => {
      this.#send(data);
      this.#timer = setTimeout(again, REPEAT_EVERY);
    };
    this.#timer = setTimeout(again, REPEAT_DELAY);
  }

  release(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/**
 * Agent TUIs (Claude Code, Codex) take text and a Return in one burst as a paste: the
 * Return becomes a new line instead of sending. So the text goes first and the Return
 * on its own after a pause, as the core's agent.send does (agents/tracker.ts, 60 ms).
 */
export const SUBMIT_DELAY = 60;

/** The compose bar's text, then Return after SUBMIT_DELAY unless `enter` is off. Resolves once both are written. */
export async function compose(write: (data: string) => Promise<unknown> | void, text: string, enter: boolean, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  if (text) await write(text);
  if (!enter) return;
  if (text) await wait(SUBMIT_DELAY);
  await write("\r");
}

/** A web address in a terminal line: http(s), up to a space or a quote, without the punctuation that ends a sentence. */
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

function trimUrl(u: string): string {
  // A closing bracket belongs to the address only when it opened one (Wikipedia's).
  for (;;) {
    const last = u[u.length - 1];
    if (last && ".,;:!?".includes(last)) u = u.slice(0, -1);
    else if (last && ")]}".includes(last)) {
      const open = { ")": "(", "]": "[", "}": "{" }[last]!;
      if (u.split(open).length >= u.split(last).length) break;
      u = u.slice(0, -1);
    } else break;
  }
  return u;
}

/** The web address at `col` of `text` (a line as the terminal shows it, wrapped lines joined), or null. */
export function linkAt(text: string, col: number): string | null {
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (col >= m.index && col < m.index + url.length) return url;
  }
  return null;
}

/** The word at `col` of `text` (a run without spaces) as [start, end), for a long-press to select; null on a space. */
export function wordAt(text: string, col: number): [number, number] | null {
  const isWord = (c: string | undefined) => c !== undefined && c !== " " && c !== " ";
  if (!isWord(text[col])) return null;
  let a = col;
  let b = col + 1;
  while (isWord(text[a - 1])) a--;
  while (isWord(text[b])) b++;
  return [a, b];
}

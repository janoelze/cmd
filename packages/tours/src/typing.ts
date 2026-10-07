// Typing rhythm: log-normal gaps between keys (right-skewed, like people),
// longer before a new word, with a floor. Real typing (~240 ms a key) looks
// sluggish on video, so the medians are faster: 65–75 ms in a terminal, about
// 100 ms in fields (VHS defaults to 50 ms). Now and then a typo: a neighbouring
// key, noticed a character or two later, a beat, backspaced and fixed.

import { between, lognormal, type Rng } from "./random.ts";

export interface TypingProfile {
  median: number;
  sigma: number;
  floor: number;
  /** Extra pause before a new word, ms. */
  word: [number, number];
  /** Chance of one typo in a text of 12+ characters. */
  typo: number;
}

export const TYPING: Record<"terminal" | "field" | "exact", TypingProfile> = {
  terminal: { median: 70, sigma: 0.35, floor: 35, word: [80, 250], typo: 0.2 },
  field: { median: 100, sigma: 0.3, floor: 45, word: [60, 180], typo: 0.35 },
  /** No typos: for text that must arrive exactly as written (a search the next step waits on). */
  exact: { median: 85, sigma: 0.3, floor: 40, word: [60, 180], typo: 0 },
};

/** Keys next to each other on a US keyboard, for believable typos. */
const NEAR: Record<string, string> = {
  a: "sqz", b: "vgn", c: "xvd", d: "sfe", e: "wrd", f: "dgr", g: "fht", h: "gjy", i: "uok", j: "hku", k: "jli", l: "ko", m: "n",
  n: "bm", o: "ip", p: "o", q: "w", r: "et", s: "adw", t: "ry", u: "yi", v: "cb", w: "qe", x: "zc", y: "tu", z: "x",
};

export interface Keystrokes {
  /** What to type, one character a key; "\b" is Backspace. */
  keys: string;
  /** The wait before each key, ms. */
  delays: number[];
}

/** The keystrokes for a text, with their timing and maybe a typo. */
export function planKeys(text: string, r: Rng, p: TypingProfile = TYPING.terminal): Keystrokes {
  const chars = [...text];
  let typoAt = -1;
  if (chars.length >= 12 && r() < p.typo) {
    // Inside a word, not its first letter, a letter we know the neighbours of.
    const spots = chars.map((c, i) => i).filter((i) => i > 0 && NEAR[chars[i]!.toLowerCase()] && /[a-z]/i.test(chars[i - 1]!));
    if (spots.length) typoAt = spots[Math.floor(r() * spots.length)]!;
  }
  const keys: string[] = [];
  const delays: number[] = [];
  const gap = (prev: string | undefined, ch: string) => {
    let d = Math.max(p.floor, lognormal(r, p.median, p.sigma));
    if (prev === " " && ch !== " ") d += between(r, ...p.word);
    return d;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (i === typoAt) {
      const near = NEAR[ch.toLowerCase()]!;
      const wrong = near[Math.floor(r() * near.length)]!;
      // The wrong key, then up to two more before it's noticed (not past the word's end).
      let run = 0;
      const more = Math.floor(r() * 3);
      keys.push(ch === ch.toUpperCase() ? wrong.toUpperCase() : wrong);
      delays.push(keys.length === 1 ? 0 : gap(chars[i - 1], ch));
      while (run < more && i + 1 + run < chars.length && /[a-z]/i.test(chars[i + 1 + run]!)) {
        keys.push(chars[i + 1 + run]!);
        delays.push(gap(keys[keys.length - 2], chars[i + 1 + run]!));
        run++;
      }
      // Noticed: a beat, then backspace over it.
      for (let b = 0; b <= run; b++) {
        keys.push("\b");
        delays.push(b === 0 ? between(r, 220, 420) : between(r, 70, 110));
      }
      keys.push(ch);
      delays.push(between(r, 120, 200));
      continue;
    }
    keys.push(ch);
    delays.push(keys.length === 1 ? 0 : gap(chars[i - 1], ch));
  }
  return { keys: keys.join(""), delays };
}

/** The delay before each character, ms (no typos). */
export function planTyping(text: string, r: Rng, p: TypingProfile = TYPING.terminal): number[] {
  return planKeys(text, r, { ...p, typo: 0 }).delays;
}

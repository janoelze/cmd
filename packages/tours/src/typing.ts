// Typing rhythm: log-normal gaps between keys (right-skewed, like people),
// longer before a new word, with a floor. Real typing (~240 ms a key) looks
// sluggish on video, so the medians are faster: 65–75 ms in a terminal, about
// 100 ms in fields (VHS defaults to 50 ms).

import { between, lognormal, type Rng } from "./random.ts";

export interface TypingProfile {
  median: number;
  sigma: number;
  floor: number;
  /** Extra pause before a new word, ms. */
  word: [number, number];
}

export const TYPING: Record<"terminal" | "field", TypingProfile> = {
  terminal: { median: 70, sigma: 0.35, floor: 35, word: [80, 250] },
  field: { median: 100, sigma: 0.3, floor: 45, word: [60, 180] },
};

/** The delay before each character, ms. */
export function planTyping(text: string, r: Rng, p: TypingProfile = TYPING.terminal): number[] {
  return [...text].map((ch, i) => {
    let d = Math.max(p.floor, lognormal(r, p.median, p.sigma));
    if (i > 0 && text[i - 1] === " " && ch !== " ") d += between(r, ...p.word);
    return i === 0 ? 0 : d;
  });
}

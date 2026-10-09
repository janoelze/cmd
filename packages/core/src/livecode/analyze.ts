// What a Live Code pattern does, as music (scripts/evals/livecode.ts): features
// read from its events over a number of bars (a cycle is a bar), not from its
// code, and a score from them. The events come from Strudel itself (queried in a
// browser by the eval); this file only reads them, so it stays testable.
//
// The features are proxies for what a listener hears: are the parts there and
// in a sensible register, does the groove fit the genre, does it stay in a key,
// does it change over time without falling apart, is the mix within budget. The
// eval checks them against ratings (`rate`) before trusting any one of them.

/** One event, as the eval's browser side reports it. */
export interface Ev {
  /** Start and end in cycles (bars). */
  b: number;
  e: number;
  /** The sound: `bank_s` for a drum machine, else `s` (or "" for none). */
  sound: string;
  /** MIDI pitch, for pitched events. */
  midi?: number;
  gain?: number;
  distort?: number;
}

export interface Genre {
  /** BPM range (four beats to a bar). */
  bpm: [number, number];
  /** Where kick and snare fall in a bar of 16 steps, for the groove check. */
  kick?: number[];
  snare?: number[];
}

export const GENRES = {
  dnb: { bpm: [168, 178], kick: [0, 10], snare: [4, 12] },
  jungle: { bpm: [155, 175], snare: [4, 12] },
  house: { bpm: [118, 128], kick: [0, 4, 8, 12], snare: [4, 12] },
  techno: { bpm: [122, 140], kick: [0, 4, 8, 12] },
  hiphop: { bpm: [70, 100], snare: [4, 12] },
  acid: { bpm: [120, 140], kick: [0, 4, 8, 12] },
  ambient: { bpm: [50, 110] },
  any: { bpm: [60, 180] },
} satisfies Record<string, Genre>;

export type GenreName = keyof typeof GENRES;

const KICK = /(^|_)(bd|kick|clubkick|hardkick|kicklinn|808bd|popkick|reverbkick)\b/;
const SNARE = /(^|_)(sd|sn|snare|cp|clap|realclaps|808sd|rm|rim)\b/;
const HATS = /(^|_)(hh|oh|ho|hat|linnhats|rd|ride|cr|808oh|808hc|hh27)\b/;
const BREAK = /(^|_)(breaks\d*|amencutup|amen|jungle)\b/;

export interface Features {
  events: number;
  bars: number;
  bpm: number | null;
  /** Distinct sounds that play. */
  parts: number;
  /** Events per bar, over all parts. */
  density: number;
  drums: { kick: boolean; snare: boolean; hats: boolean; break: boolean };
  /** How close kick and snare are to the genre's template (0-1), or null without one. */
  groove: number | null;
  /** The best-fitting key, and how well the pitches fit it (Krumhansl correlation, -1..1). */
  key: string | null;
  keyFit: number | null;
  /** Share of pitched time on notes outside that key's scale. */
  outOfKey: number | null;
  /** Most distinct pitch classes sounding at once (3+ is a chord). */
  chordSize: number;
  /** Median MIDI pitch of the lowest pitched part, and its lowest note. */
  bassMedian: number | null;
  bassLowest: number | null;
  /** Distinct bars over all bars (1/bars: a loop, 1: no bar repeats). */
  variety: number;
  /** Bars where the set of playing sounds differs from the bar before (arrangement). */
  sectionChanges: number;
  /** Most gain starting in one sixteenth (a loudness proxy), and the strongest distortion. */
  peakGain: number;
  maxDistort: number;
}

const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11];
const SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10];
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function correlate(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) (n += (a[i]! - ma) * (b[i]! - mb)), (da += (a[i]! - ma) ** 2), (db += (b[i]! - mb) ** 2);
  return da && db ? n / Math.sqrt(da * db) : 0;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : null;
};

/** The features of `events` over `bars` bars. */
export function analyze(events: Ev[], bars: number, bpm: number | null, genre: Genre = GENRES.any): Features {
  const sounds = new Set(events.map((e) => e.sound).filter(Boolean));
  const step = (e: Ev) => Math.round((e.b - Math.floor(e.b)) * 16) % 16;
  const has = (re: RegExp) => [...sounds].some((s) => re.test(s));

  // Key: pitch classes weighted by duration.
  const pitched = events.filter((e) => e.midi !== undefined && Number.isFinite(e.midi));
  const hist = new Array(12).fill(0);
  for (const e of pitched) hist[((Math.round(e.midi!) % 12) + 12) % 12] += Math.max(0.01, e.e - e.b);
  let key: string | null = null, keyFit: number | null = null, outOfKey: number | null = null;
  if (pitched.length) {
    let best = { r: -2, root: 0, minor: false };
    for (let root = 0; root < 12; root++)
      for (const minor of [false, true]) {
        const profile = (minor ? PROFILE_MINOR : PROFILE_MAJOR).map((_, i, p) => p[(i - root + 12) % 12]!);
        const r = correlate(hist, profile);
        if (r > best.r) best = { r, root, minor };
      }
    key = `${NAMES[best.root]} ${best.minor ? "minor" : "major"}`;
    keyFit = best.r;
    const scale = new Set((best.minor ? SCALE_MINOR : SCALE_MAJOR).map((i) => (i + best.root) % 12));
    const total = hist.reduce((s, x) => s + x, 0);
    outOfKey = total ? hist.reduce((s, x, pc) => s + (scale.has(pc) ? 0 : x), 0) / total : 0;
  }

  // Chords: distinct pitch classes starting together.
  const onsets = new Map<string, Set<number>>();
  for (const e of pitched) {
    const at = e.b.toFixed(4);
    if (!onsets.has(at)) onsets.set(at, new Set());
    onsets.get(at)!.add(((Math.round(e.midi!) % 12) + 12) % 12);
  }
  const chordSize = Math.max(0, ...[...onsets.values()].map((s) => s.size));

  // Bass: the pitched sound with the lowest median.
  const bySound = new Map<string, number[]>();
  for (const e of pitched) bySound.set(e.sound, [...(bySound.get(e.sound) ?? []), e.midi!]);
  const lowest = [...bySound.values()].map((ms) => ({ med: median(ms)!, min: Math.min(...ms) })).sort((x, y) => x.med - y.med)[0];

  // Variety and arrangement: a fingerprint and the set of sounds per bar.
  const prints: string[] = [], sets: string[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const inBar = events.filter((e) => e.b >= bar && e.b < bar + 1);
    prints.push(inBar.map((e) => `${e.sound}@${step(e)}:${e.midi ?? ""}`).sort().join(","));
    sets.push([...new Set(inBar.map((e) => e.sound))].sort().join(","));
  }
  let sectionChanges = 0;
  for (let i = 1; i < sets.length; i++) if (sets[i] !== sets[i - 1]) sectionChanges++;

  // Loudness proxy: summed gain of events starting in the same sixteenth.
  const slots = new Map<number, number>();
  for (const e of events) {
    const k = Math.round(e.b * 16);
    slots.set(k, (slots.get(k) ?? 0) + (e.gain ?? 1));
  }

  return {
    events: events.length,
    bars,
    bpm,
    parts: sounds.size,
    density: events.length / Math.max(1, bars),
    drums: { kick: has(KICK), snare: has(SNARE), hats: has(HATS), break: has(BREAK) },
    groove: groove(events, bars, genre),
    key,
    keyFit,
    outOfKey,
    chordSize,
    bassMedian: lowest?.med ?? null,
    bassLowest: lowest?.min ?? null,
    variety: new Set(prints).size / Math.max(1, bars),
    sectionChanges,
    peakGain: Math.max(0, ...slots.values()),
    maxDistort: Math.max(0, ...events.map((e) => e.distort ?? 0)),
  };
}

/** How well kick and snare follow a genre's template: hits on it count, hits off it cost. */
export function groove(events: Ev[], bars: number, genre: Genre): number | null {
  if (!genre.kick && !genre.snare) return null;
  const score = (re: RegExp, template: number[] | undefined) => {
    if (!template) return null;
    let on = 0, off = 0;
    for (let bar = 0; bar < bars; bar++) {
      const steps = new Set(events.filter((e) => e.b >= bar && e.b < bar + 1 && re.test(e.sound)).map((e) => Math.round((e.b - bar) * 16) % 16));
      for (const s of template) if (steps.has(s)) on++;
      for (const s of steps) if (!template.includes(s)) off++;
    }
    const possible = template.length * bars;
    return Math.max(0, (on - off * 0.5) / possible);
  };
  // A chopped break carries its own kick and snare: without separate ones, its hits stand in.
  const sounds = new Set(events.map((e) => e.sound));
  const only = (re: RegExp) => ([...sounds].some((s) => re.test(s)) ? re : BREAK);
  const parts = [score(only(KICK), genre.kick), score(only(SNARE), genre.snare)].filter((x): x is number => x !== null);
  return parts.length ? parts.reduce((s, x) => s + x, 0) / parts.length : null;
}

export interface Score {
  total: number;
  /** Each check, 0-1, and why it lost points. */
  checks: { name: string; score: number; note?: string }[];
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const within = (x: number, lo: number, hi: number, slack: number) => (x >= lo && x <= hi ? 1 : clamp(1 - (x < lo ? lo - x : x - hi) / slack));

/** A score out of 100 from the features; `unknown` is how many sounds don't exist. */
export function score(f: Features, genre: Genre, unknown: number): Score {
  const checks: Score["checks"] = [];
  const add = (name: string, s: number, note?: string) => checks.push({ name, score: clamp(s), ...(s < 0.999 && note ? { note } : {}) });
  add("sounds", unknown ? 0 : 1, `${unknown} unknown`);
  add("tempo", f.bpm === null ? 0.5 : within(f.bpm, genre.bpm[0], genre.bpm[1], 20), `${f.bpm?.toFixed(0) ?? "?"} BPM`);
  // Strudel's own tunes have 2-6 parts and ~8 events a bar; a full track needs more, a crowded one sounds like noise.
  add("parts", within(f.parts, 3, 7, 4), `${f.parts} parts`);
  add("clutter", within(f.density, 4, 36, 30), `${f.density.toFixed(0)} events a bar`);
  if (f.groove !== null) add("groove", f.groove, `groove ${f.groove.toFixed(2)}`);
  if (genre !== GENRES.ambient) add("drums", (+(f.drums.kick || f.drums.break) + +(f.drums.snare || f.drums.break) + +(f.drums.hats || f.drums.break)) / 3, "missing kick, snare or hats");
  add("harmony", f.keyFit === null ? 0 : clamp((f.keyFit - 0.4) / 0.4) * (1 - clamp((f.outOfKey ?? 0) / 0.2)), `key fit ${f.keyFit?.toFixed(2) ?? "-"}, ${(100 * (f.outOfKey ?? 0)).toFixed(0)}% out of key`);
  add("chords", f.chordSize >= 3 ? 1 : f.chordSize / 3, `${f.chordSize} notes at once`);
  // Bass in octave 2 (MIDI 36-52) is heard on any speaker; below E1 (28) nothing but a sub system plays it.
  add("bass", f.bassMedian === null ? 0 : within(f.bassMedian, 36, 52, 10) * (f.bassLowest !== null && f.bassLowest < 28 ? 0.5 : 1), `bass median ${f.bassMedian ?? "-"}, lowest ${f.bassLowest ?? "-"}`);
  add("variety", within(f.variety, 0.25, 0.85, 0.25), `${(100 * f.variety).toFixed(0)}% distinct bars`);
  add("arrangement", clamp(f.sectionChanges / 3), `${f.sectionChanges} section changes`);
  add("mix", within(f.peakGain, 0, 5, 4) * (f.maxDistort > 1 ? 0.5 : 1), `peak gain ${f.peakGain.toFixed(1)}, distort ${f.maxDistort}`);
  return { total: Math.round((100 * checks.reduce((s, c) => s + c.score, 0)) / checks.length), checks };
}

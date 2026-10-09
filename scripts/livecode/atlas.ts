// The sound atlas (pnpm livecode build): what every sample sound a Jam frame
// loads actually is, measured from its audio, for Jam's AI (core
// livecode/change.ts puts atlas.md in its system prompt) and its evals (atlas.json).
// The names alone say little: "breaks152" is three bars long, "jvbass" is a synth
// bass, "arpy" is a tone.
//
// For each sound name in the sample maps (apps/desktop/src/livecode/sample-maps.json)
// it measures the first sample (the middle one for pitched maps like the piano):
// length, loudness, where its energy sits (lows, mids, highs, brightness), its
// pitch if it has one, its attack, and how many hits it has (a single hit, a
// phrase, or a loop of bars). Samples aren't kept; measurements are cached in
// .cmd-dev/livecode/atlas-cache.json, so a rebuild only fetches what changed.

import fs from "node:fs";
import path from "node:path";
import { openStrudel, root, SAMPLE_MAPS, type Measure } from "./browser.ts";

const OUT = path.join(root, "packages/core/src/livecode");
const CACHE = path.join(root, ".cmd-dev/livecode/atlas-cache.json");
const BANK_MAPS = new Set(["tidal-drum-machines", "EmuSP12"]);

interface Sound {
  name: string;
  map: string;
  count: number;
  pitched: boolean;
  file: string;
}

type Measured = Exclude<Measure, { error: string }>;

const NOTES = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
const noteName = (m: number) => `${NOTES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

/** A few words a musician would use, from the measurements. */
export function describe(s: Pick<Sound, "name" | "pitched">, m: Measured): string {
  const words: string[] = [];
  const bpm = /^breaks(\d+)$/.exec(s.name)?.[1];
  const sec = m.seconds < 10 ? m.seconds.toFixed(2) : m.seconds.toFixed(0);
  if (bpm) words.push(`loop ${sec}s = ${((m.seconds * Number(bpm)) / 240).toFixed(1)} bars at ${bpm} BPM`);
  else if (m.hits >= 6 && m.seconds > 1.5) words.push(`phrase or loop ${sec}s, ${m.hits} hits`);
  else if (m.audibleMs < 250) words.push(`short hit ${sec}s`);
  else if (m.audibleMs < 900) words.push(`hit ${sec}s`);
  else words.push(`long ${sec}s`);
  // A pitch only for tones: pitched maps, or a sound that rings (a drum hit's "pitch" is noise).
  if (m.pitch !== null && !bpm && (s.pitched || (m.audibleMs > 400 && m.hits <= 2))) words.push(`pitched ~${noteName(m.pitch)}`);
  if (m.low > 0.55) words.push("deep, mostly lows");
  else if (m.low > 0.3) words.push("low end");
  if (m.high > 0.45) words.push("bright, mostly highs");
  else if (m.centroid < 600 && m.low <= 0.55) words.push("dark");
  // Attack only means something for a single sound (a loop's loudest moment can come late).
  if (m.attackMs > 80 && !bpm && m.hits <= 2) words.push(`soft attack ${m.attackMs}ms`);
  if (m.rmsDb < -32) words.push("quiet");
  else if (m.rmsDb > -14) words.push("loud");
  return words.join(", ");
}

/** Every sound name in the sample maps, its sample count, and the file to measure. */
async function listSounds(): Promise<Sound[]> {
  const sounds: Sound[] = [];
  for (const { name: map, url } of SAMPLE_MAPS) {
    const json = (await (await fetch(url)).json()) as Record<string, unknown>;
    const at = typeof json._base === "string" ? json._base : url.slice(0, url.lastIndexOf("/") + 1);
    for (const [name, files] of Object.entries(json)) {
      if (name === "_base") continue;
      const list = Array.isArray(files) ? (files as string[]) : typeof files === "string" ? [files] : Object.values(files as Record<string, string>);
      const byNote = !Array.isArray(files) && typeof files === "object" ? (files as Record<string, string>) : null;
      // Pitched maps (note → file): measure the one nearest the middle.
      const pick = byNote ? (byNote.c4 ?? byNote.C4 ?? list[Math.floor(list.length / 2)]) : list[0];
      sounds.push({ name: name.toLowerCase(), map, count: list.length, pitched: !!byNote, file: at + pick });
    }
  }
  return sounds;
}

export async function buildAtlas(): Promise<void> {
  const sounds = await listSounds();
  console.log(`atlas: ${sounds.length} sounds in ${SAMPLE_MAPS.length} maps`);
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  const cache: Record<string, Measure> = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  const queue = sounds.filter((s) => !cache[s.file]);
  const total = queue.length;
  if (total) {
    const strudel = await openStrudel();
    let done = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let s; (s = queue.shift()); ) {
          cache[s.file] = await strudel.measure(s.file);
          if (++done % 50 === 0) console.log(`  ${done}/${total}`), fs.writeFileSync(CACHE, JSON.stringify(cache));
        }
      }),
    );
    await strudel.close();
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  }

  // atlas.json: the numbers. Sounds whose sample doesn't load are kept, marked, so nothing suggests them.
  const atlas = sounds
    .map((s) => {
      const m = cache[s.file];
      return !m || "error" in m ? { name: s.name, map: s.map, samples: s.count, broken: true as const } : { name: s.name, map: s.map, samples: s.count, ...m, about: describe(s, m) };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
  fs.writeFileSync(path.join(OUT, "atlas.json"), JSON.stringify(atlas, null, 0).replace(/},{/g, "},\n{") + "\n");

  // atlas.md, for the prompt: drum machine banks one line each, every other sound on its own line.
  const ok = atlas.filter((a): a is Extract<(typeof atlas)[number], { about: string }> => !("broken" in a));
  const lines = [
    "# Sound atlas",
    "",
    'Every loaded sample sound, measured from its audio (pnpm livecode build): `name (samples): what it is`. Lengths are of the first sample; `n` picks another. Drum machines are banks of short hits: `s("bd sd").bank("RolandTR909")`.',
    "",
    "## Drum machine banks",
  ];
  const banks = new Map<string, string[]>();
  for (const a of ok.filter((x) => BANK_MAPS.has(x.map))) {
    const i = a.name.lastIndexOf("_");
    const bank = a.name.slice(0, i);
    if (!banks.has(bank)) banks.set(bank, []);
    banks.get(bank)!.push(`${a.name.slice(i + 1)}${a.samples > 1 ? `(${a.samples})` : ""}${a.low > 0.55 ? " deep" : a.high > 0.45 ? " bright" : ""}`);
  }
  for (const [bank, hits] of [...banks].sort()) lines.push(`- ${bank}: ${hits.join(", ")}`);
  lines.push("", "## Sounds");
  for (const a of ok.filter((x) => !BANK_MAPS.has(x.map))) lines.push(`- ${a.name} (${a.samples}): ${a.about}`);
  const broken = atlas.filter((a) => "broken" in a).map((a) => a.name);
  if (broken.length) lines.push("", `Do not use (their samples don't load): ${broken.join(", ")}.`);
  fs.writeFileSync(path.join(OUT, "atlas.md"), lines.join("\n") + "\n");
  console.log(`atlas: ${ok.length} sounds measured, ${broken.length} don't load → atlas.json, atlas.md (${Math.round(fs.statSync(path.join(OUT, "atlas.md")).size / 1024)} KB)`);
}

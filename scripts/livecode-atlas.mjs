#!/usr/bin/env node
// Writes packages/core/src/livecode/atlas.json and atlas.md: what every sample
// sound Live Code loads actually is, measured from its audio, for Live Code's AI
// (livecode/change.ts) and its evals. The sounds' names alone say little
// ("breaks152" is three bars long, "jvbass" is a synth bass, "arpy" is a tone).
//
// For each sound name in the frame's sample maps (apps/desktop/src/livecode/frame.js)
// it decodes the first sample (the middle one for pitched maps like the piano) in
// headless Chromium and measures: length, loudness, where its energy sits (lows,
// mids, highs, brightness), its pitch if it has one, its attack, and how many hits
// it has (a single hit, a phrase, or a loop of bars). The samples themselves are
// not kept. Results are cached in .cmd-dev/atlas-cache.json, so a rerun only
// fetches what changed.
//
//   node scripts/livecode-atlas.mjs          (after changing the sample maps)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const frame = fs.readFileSync(path.join(root, "apps/desktop/src/livecode/frame.js"), "utf8");
const base = /const MAPS = "([^"]+)"/.exec(frame)[1];
const banks = /\[("[\w-]+"(?:, "[\w-]+")*)\]\.map/.exec(frame)[1].match(/[\w-]+/g);
const maps = [...banks.map((b) => ({ map: b, url: `${base}${b}.json` })), ...[...frame.matchAll(/"(https:\/\/raw\.githubusercontent\.com\/[^"]+\.json)"/g)].map((m) => ({ map: /tidalcycles/.test(m[1]) ? "Dirt-Samples" : m[1], url: m[1] }))];

// Every sound name, its sample count and the file to measure.
const sounds = [];
for (const { map, url } of maps) {
  const json = await (await fetch(url)).json();
  const at = json._base ?? url.slice(0, url.lastIndexOf("/") + 1);
  for (const [name, files] of Object.entries(json)) {
    if (name === "_base") continue;
    const list = Array.isArray(files) ? files : typeof files === "string" ? [files] : Object.values(files);
    // Pitched maps (note → file): measure the one nearest the middle.
    const pick = Array.isArray(files) || typeof files === "string" ? list[0] : (files.c4 ?? files.C4 ?? list[Math.floor(list.length / 2)]);
    sounds.push({ name: name.toLowerCase(), map, count: list.length, pitched: !Array.isArray(files) && typeof files === "object", file: at + pick });
  }
}
console.log(`${sounds.length} sounds in ${maps.length} maps`);

const cacheFile = path.join(root, ".cmd-dev/atlas-cache.json");
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
const todo = sounds.filter((s) => !cache[s.file]);

const { chromium } = createRequire(path.join(root, "package.json"))("playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");
// The measuring code, in the page: decode, then look at the samples.
await page.evaluate(() => {
  const fft = (re, im) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) [re[i], re[j], im[i], im[j]] = [re[j], re[i], im[j], im[i]];
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < n; i += len)
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi, vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        }
    }
  };
  window.measure = async (url) => {
    const res = await fetch(url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 44100);
    let audio;
    try {
      audio = await ctx.decodeAudioData(buf);
    } catch (e) {
      return { error: "decode: " + e.message };
    }
    const sr = audio.sampleRate, len = audio.length;
    const x = new Float32Array(len);
    for (let c = 0; c < audio.numberOfChannels; c++) audio.getChannelData(c).forEach((v, i) => (x[i] += v / audio.numberOfChannels));
    let peak = 0, sum = 0;
    for (const v of x) (peak = Math.max(peak, Math.abs(v))), (sum += v * v);
    const db = (v) => (v > 0 ? 20 * Math.log10(v) : -120);
    // Envelope in 10 ms frames: attack, how long it sounds, and hits (energy jumps).
    const hop = Math.round(sr / 100), env = [];
    for (let i = 0; i < len; i += hop) {
      let e = 0;
      for (let j = i; j < Math.min(len, i + hop); j++) e += x[j] * x[j];
      env.push(Math.sqrt(e / hop));
    }
    const top = Math.max(...env, 1e-9);
    const attackMs = env.findIndex((e) => e >= top * 0.9) * 10;
    const audibleMs = (env.length - [...env].reverse().findIndex((e) => e > top * 0.03)) * 10;
    let hits = 0;
    for (let i = 2; i < env.length; i++) if (env[i] > top * 0.25 && env[i] > 1.8 * Math.max(env[i - 1], env[i - 2], 1e-6)) hits++;
    // Spectrum, averaged over up to 32 frames of the sounding part: bands and brightness.
    const N = 4096, bins = new Float64Array(N / 2);
    const end = Math.min(len, Math.round((audibleMs / 1000) * sr));
    const frames = Math.max(1, Math.min(32, Math.floor(end / N)));
    for (let f = 0; f < frames; f++) {
      const re = new Float64Array(N), im = new Float64Array(N);
      const start = Math.floor((f * Math.max(0, end - N)) / frames);
      for (let i = 0; i < N && start + i < len; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      fft(re, im);
      for (let k = 0; k < N / 2; k++) bins[k] += re[k] * re[k] + im[k] * im[k];
    }
    const hz = (k) => (k * sr) / N;
    let low = 0, mid = 0, high = 0, total = 0, centroid = 0;
    bins.forEach((p, k) => {
      const f = hz(k);
      if (f < 20) return;
      total += p;
      centroid += f * p;
      if (f < 150) low += p;
      else if (f < 4000) mid += p;
      else high += p;
    });
    // Pitch: the strongest spectral peak with its harmonics, if the sound is tonal.
    let pitch = null;
    {
      let best = 0, bestK = 0;
      for (let k = Math.ceil(40 / (sr / N)); k < Math.floor(2000 / (sr / N)); k++) {
        const h = bins[k] + 0.5 * (bins[2 * k] ?? 0) + 0.33 * (bins[3 * k] ?? 0);
        if (h > best) (best = h), (bestK = k);
      }
      const share = (bins[bestK - 1] + bins[bestK] + bins[bestK + 1]) / (total || 1);
      if (share > 0.08 && bestK) pitch = Math.round(69 + 12 * Math.log2(hz(bestK) / 440));
    }
    return {
      seconds: +(len / sr).toFixed(3),
      peakDb: +db(peak).toFixed(1),
      rmsDb: +db(Math.sqrt(sum / len)).toFixed(1),
      attackMs,
      audibleMs,
      hits,
      low: +(low / total).toFixed(2),
      mid: +(mid / total).toFixed(2),
      high: +(high / total).toFixed(2),
      centroid: Math.round(centroid / total),
      pitch,
    };
  };
});

let done = 0;
const queue = [...todo];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let s; (s = queue.shift()); ) {
      cache[s.file] = await page.evaluate((u) => window.measure(u), s.file).catch((e) => ({ error: e.message }));
      if (++done % 50 === 0) {
        console.log(`${done}/${todo.length}`);
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
      }
    }
  }),
);
await browser.close();
fs.writeFileSync(cacheFile, JSON.stringify(cache));

// ── describe ───────────────────────────────────────────

const NOTES = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
const noteName = (m) => `${NOTES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

/** A few words a musician would use, from the measurements. */
function describe(s, m) {
  if (m.error) return null;
  const words = [];
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

const atlas = [];
for (const s of sounds) {
  const m = cache[s.file];
  if (!m || m.error) continue;
  atlas.push({ name: s.name, map: s.map, samples: s.count, ...m, about: describe(s, m) });
}
// Sounds whose sample doesn't load: kept, marked, so nothing suggests them.
for (const s of sounds) if (cache[s.file]?.error) atlas.push({ name: s.name, map: s.map, samples: s.count, broken: true });
atlas.sort((x, y) => x.name.localeCompare(y.name));
const out = path.join(root, "packages/core/src/livecode");
fs.writeFileSync(path.join(out, "atlas.json"), JSON.stringify(atlas, null, 0).replace(/},{/g, "},\n{") + "\n");

// The prompt's version: drum machine banks one line each, every other sound on its own line.
const lines = ["# Sound atlas", "", "Every loaded sample sound, measured from its audio (scripts/livecode-atlas.mjs): `name (samples): what it is`. Lengths are of the first sample; `n` picks another. Drum machines are banks of short hits: `s(\"bd sd\").bank(\"RolandTR909\")`.", "", "## Drum machine banks"];
const bankRows = new Map();
for (const a of atlas.filter((x) => !x.broken && (x.map === "tidal-drum-machines" || x.map === "EmuSP12"))) {
  const i = a.name.lastIndexOf("_");
  const bank = a.name.slice(0, i), hit = a.name.slice(i + 1);
  if (!bankRows.has(bank)) bankRows.set(bank, []);
  bankRows.get(bank).push(`${hit}${a.samples > 1 ? `(${a.samples})` : ""}${a.low > 0.55 ? " deep" : a.high > 0.45 ? " bright" : ""}`);
}
for (const [bank, hits] of [...bankRows].sort()) lines.push(`- ${bank}: ${hits.join(", ")}`);
lines.push("", "## Sounds");
for (const a of atlas.filter((x) => !x.broken && x.map !== "tidal-drum-machines" && x.map !== "EmuSP12")) lines.push(`- ${a.name} (${a.samples}): ${a.about}`);
lines.push("", `Do not use (their samples don't load): ${atlas.filter((x) => x.broken).map((x) => x.name).join(", ")}.`);
fs.writeFileSync(path.join(out, "atlas.md"), lines.join("\n") + "\n");
console.log(`${atlas.filter((x) => !x.broken).length} sounds measured (${atlas.filter((x) => x.broken).length} don't load) → atlas.json, atlas.md (${Math.round(fs.statSync(path.join(out, "atlas.md")).size / 1024)} KB)`);

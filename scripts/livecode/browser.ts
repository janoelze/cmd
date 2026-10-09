// Strudel in headless Chromium, for the Live Code tooling (pnpm livecode): the
// same @strudel/web as the app's frame, with the same sample maps
// (apps/desktop/src/livecode/sample-maps.json). It evaluates code into events
// (the evals score them), plays code and listens (the audio check), lists the
// sounds the maps load, and measures samples (the atlas).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Ev } from "../../packages/core/src/livecode/analyze.ts";

export const root = path.resolve(import.meta.dirname, "../..");

/** The sample maps the app's Live Code frame loads. */
export const SAMPLE_MAPS = (JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/src/livecode/sample-maps.json"), "utf8")) as { maps: { name: string; url: string }[] }).maps;

/** What the code sounds like when played (audio check). */
export interface Audio {
  /** Sounds that played nothing. */
  silent: string[];
  /** Each sound's level alone (RMS). */
  parts: Record<string, number>;
  /** The mix's peak before the app's limiter (over 1 clips), and its share of energy below 150 Hz. */
  peak: number;
  lows: number;
}

/** A sample, measured from its audio (or why it couldn't be). */
export type Measure =
  | { error: string }
  | { seconds: number; peakDb: number; rmsDb: number; attackMs: number; audibleMs: number; hits: number; low: number; mid: number; high: number; centroid: number; pitch: number | null };

/** A page with Strudel and the app's sample maps, evaluating code and returning its events. */
export async function openStrudel() {
  const { chromium } = createRequire(path.join(root, "package.json"))("playwright") as typeof import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // A secure origin: about:blank isn't one, and without it there are no AudioWorklets
  // (supersaw, distortion, the ladder filter play silence).
  await page.route("https://strudel.eval/", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>eval</title>" }));
  await page.goto("https://strudel.eval/");
  await page.addScriptTag({ path: path.join(root, "apps/desktop/node_modules/@strudel/web/dist/index.js") });
  // The same sample maps as a Live Code frame, for knowing which sounds exist.
  const all = SAMPLE_MAPS.map((m) => m.url);
  await page.evaluate(async (all) => {
    const w = window as unknown as Record<string, any>;
    w.__err = null;
    w.repl = await w.initStrudel({ prebake: () => Promise.all(all.map((u: string) => w.samples(u).catch(() => {}))), onEvalError: (e: Error) => (w.__err = String(e?.message ?? e)) });
    // As the app's frame does (apps/desktop/src/livecode/frame.js): the effect worklets load on a click otherwise.
    await w.strudel.initAudio().catch(() => {});
  }, all);
  // Measuring a sample (pnpm livecode build: the atlas): decode it, then look at it.
  await page.evaluate(() => {
      const w = window as unknown as Record<string, any>;
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
    w.measure = async (url: string) => {
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
  return {
    /** What a sample is, measured from its audio (see Measure). */
    measure: (url: string) => page.evaluate((u) => (window as unknown as Record<string, any>).measure(u), url).catch((e: Error) => ({ error: e.message })) as Promise<Measure>,
    async run(code: string, bars: number): Promise<{ error?: string; events: Ev[]; unknown: string[] }> {
      return page.evaluate(
        async ({ code, bars }) => {
          const w = window as unknown as Record<string, any>;
          w.__err = null;
          let pattern;
          try {
            pattern = await w.strudel.evaluate(code, false);
          } catch (e) {
            return { error: String((e as Error)?.message ?? e), events: [], unknown: [] };
          }
          if (w.__err || !pattern?.queryArc) return { error: w.__err ?? "no pattern", events: [], unknown: [] };
          const known = new Set(Object.keys(w.strudel.soundMap.get()));
          const unknown = new Set<string>();
          const events = [];
          let haps;
          try {
            haps = pattern.queryArc(0, bars).filter((h: any) => h.hasOnset());
          } catch (e) {
            return { error: String((e as Error)?.message ?? e), events: [], unknown: [] };
          }
          for (const h of haps) {
            const v = h.value ?? {};
            const s = typeof v.s === "string" ? v.s.toLowerCase() : "";
            const sound = v.bank && s ? `${String(v.bank).toLowerCase()}_${s}` : s;
            if (sound && !known.has(sound)) unknown.add(sound);
            let midi: number | undefined;
            if (typeof v.note === "number") midi = v.note;
            else if (typeof v.note === "string") midi = w.strudel.noteToMidi?.(v.note);
            else if (typeof v.freq === "number") midi = 69 + 12 * Math.log2(v.freq / 440);
            const num = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" ? parseFloat(x) : undefined);
            events.push({ b: h.whole.begin.valueOf(), e: h.whole.end.valueOf(), sound, ...(midi !== undefined && Number.isFinite(midi) ? { midi } : {}), ...(num(v.gain) !== undefined ? { gain: num(v.gain) } : {}), ...(num(v.distort) !== undefined ? { distort: num(v.distort) } : {}) });
          }
          w.strudel.hush?.();
          return { events, unknown: [...unknown] };
        },
        { code, bars },
      );
    },
    /** Every sound the maps loaded, as the app sends them to the model. */
    sounds: () => page.evaluate(() => Object.keys((window as unknown as Record<string, any>).strudel.soundMap.get()).sort()) as Promise<string[]>,
    /**
     * Plays the code: each sound alone for `seconds` (is it heard at all?), then
     * the whole mix (its peak before any limiter, and its share of lows).
     */
    async audio(code: string, seconds = 2.5): Promise<Audio> {
      return page.evaluate(
        async ({ code, seconds }) => {
          const w = window as unknown as Record<string, any>;
          const pattern = await w.strudel.evaluate(code, false);
          if (!pattern?.queryArc) return { silent: [], parts: {}, peak: 0, lows: 0 };
          const soundOf = (v: any) => (typeof v?.s === "string" ? (v.bank ? `${String(v.bank).toLowerCase()}_${v.s.toLowerCase()}` : v.s.toLowerCase()) : "");
          const sounds = [...new Set(pattern.queryArc(0, 16).map((h: any) => soundOf(h.value)).filter(Boolean))] as string[];
          const listen = async (p: any) => {
            w.repl.setPattern(p, true);
            await new Promise((r) => setTimeout(r, 300));
            const out = w.strudel.getSuperdoughAudioController().output.destinationGain;
            const a = out.context.createAnalyser();
            a.fftSize = 2048;
            out.connect(a);
            const buf = new Float32Array(2048), spec = new Float32Array(1024);
            const bin = out.context.sampleRate / 2048;
            let sum = 0, n = 0, peak = 0, lo = 0, all = 0;
            const end = Date.now() + seconds * 1000;
            while (Date.now() < end) {
              await new Promise((r) => setTimeout(r, 40));
              a.getFloatTimeDomainData(buf);
              for (const x of buf) (sum += x * x), n++, (peak = Math.max(peak, Math.abs(x)));
              a.getFloatFrequencyData(spec);
              spec.forEach((d, k) => {
                const p = Math.pow(10, d / 10);
                all += p;
                if (k * bin < 150) lo += p;
              });
            }
            out.disconnect(a);
            w.repl.stop();
            await new Promise((r) => setTimeout(r, 150));
            return { rms: Math.sqrt(sum / Math.max(1, n)), peak, lows: all ? lo / all : 0 };
          };
          const parts: Record<string, number> = {};
          // Each sound alone, from the bar it first plays in (parts can enter late in an arrangement).
          for (const sound of sounds) {
            const alone = pattern.filterValues((v: any) => soundOf(v) === sound);
            const first = alone.queryArc(0, 16).filter((h: any) => h.hasOnset()).reduce((m: number, h: any) => Math.min(m, Math.floor(h.whole.begin.valueOf())), 16);
            parts[sound] = +(await listen(alone.early(first))).rms.toFixed(4);
          }
          const mix = await listen(pattern);
          return { silent: sounds.filter((s) => parts[s]! < 0.002), parts, peak: +mix.peak.toFixed(2), lows: +mix.lows.toFixed(2) };
        },
        { code, seconds },
      );
    },
    close: () => browser.close(),
  };
}

/** BPM from setcpm/setcps in the code (four beats to a cycle). */
export function bpmOf(code: string): number | null {
  const at = (re: RegExp) => re.exec(code)?.[1];
  try {
    const cpm = at(/setcpm\(([^)]*)\)/);
    if (cpm) return Number(Function(`return (${cpm})`)()) * 4;
    const cps = at(/setcps\(([^)]*)\)/);
    if (cps) return Number(Function(`return (${cps})`)()) * 60 * 4;
  } catch {}
  return null;
}

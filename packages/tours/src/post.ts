// Post: turns a run into a video that looks like a screen recording of a Mac.
// The recording has no cursor and square corners; the run also has
// window.png, a still of the window alone with macOS's real shadow, and the
// event log with every pointer move and the real system cursor's shapes.
//
//   wallpaper → the still's shadow → the recording, masked to the window's real
//   shape (the still's alpha: its rounded corners) → the real cursor, each
//   frame where the log says and in the shape the system showed (arrow,
//   I-beam, resize…) → 60 fps H.264
//
//   node packages/tours/src/post.ts <run dir> [--wallpaper img] [--cursor 1.0] [--clicks] [--idle 4] [--width 1920] [--follow 1.6] [--auto-camera] [--real-time]
//
// No smoothing: the driver's paths are already human; a real recording has none.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { autoCamera, cameraPath, type CameraMark } from "./camera.ts";
import { buildRenderer } from "./helper.ts";

interface Ev {
  t: number;
  type: string;
  mode?: CameraMark["mode"];
  rect?: number[];
  zoom?: number;
  /** A hold's length (t.pause), ms. */
  ms?: number;
  x?: number;
  y?: number;
  id?: number;
  hx?: number;
  hy?: number;
  w?: number;
  h?: number;
}
interface Meta {
  rect: { x: number; y: number; width: number; height: number };
  scale: number;
  width: number;
  height: number;
  t0: number;
  t1: number;
}

export interface PostOptions {
  /** An image behind the window; default: a generated gradient. */
  wallpaper?: string;
  /** The cursor's size relative to the real one (1 = what the screen showed). */
  cursor?: number;
  /** A ring where clicks land (real recordings have none). */
  clicks?: boolean;
  /** Output width, px (16:10). */
  width?: number;
  /** How much of the output's width the window takes. */
  fill?: number;
  /**
   * Speed up stretches without input (waiting on an agent, a build) by this
   * factor; about a second at each end stays real-time. Off by default: a real
   * recording doesn't do it, a product video often does.
   */
  idle?: number;
  /**
   * Cut dead time: stretches with no input and nothing changing on screen shrink to 0.3 s.
   * On by default (a tour's pauses and waits add up); false keeps real time.
   */
  tighten?: boolean;
  /** Follow the pointer the whole video at this zoom (tours mark the camera with t.camera instead). */
  follow?: number;
  /** "auto": zoom in on bursts of clicking and typing, whole window while scrolling (camera.ts autoCamera); a tour's own t.camera marks win. */
  camera?: "auto";
}

/** Input-free stretches longer than this are sped up (with `idle`), seconds. */
const IDLE_FROM = 3;
/** Real-time time kept at each end of a sped-up stretch, seconds. */
const IDLE_KEEP = 0.9;
/** Dead time (no input, nothing changing on screen) longer than this is cut down to DEAD_KEEP, seconds. */
const DEAD_FROM = 0.6;
const DEAD_KEEP = 0.3;
/** Real time kept around an input before dead time starts or after it ends, seconds. */
const DEAD_MARGIN = 0.15;

/**
 * How fast each part of the recording plays: [start, end, speed] in source
 * seconds, covering it all. Dead time (no input and a frozen screen) shrinks
 * to DEAD_KEEP; with `idle`, input-free stretches where something still
 * happens (an agent's output streaming in) play `idle` times faster, their
 * ends real-time; everything else is real-time.
 */
export function timeSegments(inputs: number[], frozen: [number, number][], duration: number, o: { idle?: number; tighten?: boolean; holds?: [number, number][] } = {}): [number, number, number][] {
  const ins = inputs.filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b);
  const fast: [number, number, number][] = [];
  if (o.idle && o.idle > 1) {
    const marks = [0, ...ins, duration];
    for (let i = 1; i < marks.length; i++) {
      const a = marks[i - 1]!, b = marks[i]!;
      if (b - a >= IDLE_FROM) fast.push([a + IDLE_KEEP, b - IDLE_KEEP, o.idle]);
    }
  }
  const holds = (o.holds ?? []).slice().sort((a, b) => a[0] - b[0]);
  if (o.tighten !== false) {
    // A deliberate pause (t.pause: a hold) is never cut: take holds out of the frozen stretches.
    const unheld: [number, number][] = [];
    for (const [fa, fb] of frozen) {
      let at = fa;
      for (const [ha, hb] of holds) {
        if (hb <= at || ha >= fb) continue;
        if (ha > at) unheld.push([at, ha]);
        at = Math.max(at, hb);
      }
      if (at < fb) unheld.push([at, fb]);
    }
    for (const [fa, fb] of unheld) {
      // Split at inputs inside the frozen stretch; keep a little real time around each.
      const cuts = [fa, ...ins.filter((t) => t > fa && t < fb), fb];
      const nearInput = (t: number) => ins.some((x) => Math.abs(x - t) < 0.05);
      for (let i = 1; i < cuts.length; i++) {
        const a = cuts[i - 1]! + (nearInput(cuts[i - 1]!) ? DEAD_MARGIN : 0);
        const b = cuts[i]! - (nearInput(cuts[i]!) ? DEAD_MARGIN : 0);
        if (b - a > DEAD_FROM) fast.push([a, b, (b - a) / DEAD_KEEP]);
      }
    }
  }
  // Sweep: each piece plays at the fastest speed asked for it, neighbours of the same speed merge.
  const edges = [...new Set([0, duration, ...fast.flatMap(([a, b]) => [a, b])])].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b);
  const out: [number, number, number][] = [];
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1]!, b = edges[i]!;
    if (b - a < 1e-6) continue;
    const mid = (a + b) / 2;
    // A dead stretch's speed shrinks the whole stretch: spread it over this piece by its share.
    // A hold plays in real time, whatever else asks for speed.
    const held = holds.some(([ha, hb]) => mid > ha && mid < hb);
    const k = held ? 1 : Math.max(1, ...fast.filter(([fa, fb]) => mid > fa && mid < fb).map(([, , sp]) => sp));
    const last = out.at(-1);
    if (last && Math.abs(last[2] - k) < 1e-9) last[1] = b;
    else out.push([a, b, k]);
  }
  return out;
}

/** The old name: idle stretches only. */
export function idleSegments(events: { t: number; type: string }[], t0: number, duration: number, speed: number): [number, number, number][] {
  const inputs = events.filter((e) => e.type !== "cursor").map((e) => (e.t - t0) / 1e9);
  return timeSegments(inputs, [], duration, { idle: speed });
}

/** Each frame's time in a recording, seconds from the first, in presentation order (HEVC stores them out of order). */
export function frameTimes(video: string): number[] {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", video], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const t = out.split("\n").map((l) => parseFloat(l)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  return t.map((x) => Math.round((x - t[0]!) * 1e6) / 1e6);
}

/** Where the recording is frozen (nothing on screen changing beyond noise), [start, end] seconds. */
export function frozenStretches(video: string, duration: number): [number, number][] {
  // freezedetect reports on stderr; small changes (a blinking caret, a spinner) stay under its noise floor.
  const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-i", video, "-vf", "scale=320:-1,freezedetect=n=0.02:d=0.4", "-map", "0:v", "-f", "null", "-"], { encoding: "utf8" });
  const out: [number, number][] = [];
  let start: number | null = null;
  for (const m of stderr.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
    if (m[1] === "start") start = Number(m[2]);
    else if (start !== null) (out.push([start, Number(m[2])]), (start = null));
  }
  if (start !== null) out.push([start, duration]);
  return out;
}

const ASSETS = path.join(import.meta.dirname, "..", "assets");
const FPS = 60;
const RING_MS = 280;
const even = (n: number) => Math.round(n / 2) * 2;

/** The pointer's position (screen points) at a time (ns), from the logged moves and presses. */
export function pointerAt(events: Ev[], t: number): { x: number; y: number } | null {
  let prev: Ev | null = null;
  for (const e of events) {
    if (e.x === undefined || e.y === undefined) continue;
    if (e.t >= t) {
      if (!prev) return { x: e.x, y: e.y };
      // Interpolate only within a move (events close together); otherwise the pointer rests.
      if (e.t - prev.t > 50e6) return { x: prev.x!, y: prev.y! };
      const f = (t - prev.t) / (e.t - prev.t || 1);
      return { x: prev.x! + (e.x - prev.x!) * f, y: prev.y! + (e.y - prev.y!) * f };
    }
    prev = e;
  }
  return prev ? { x: prev.x!, y: prev.y! } : null;
}

/** The cursor shape shown at a time: the last logged change before it. */
export function cursorAt(events: Ev[], t: number): Ev | null {
  let cur: Ev | null = null;
  for (const e of events) {
    if (e.t > t) break;
    if (e.type === "cursor") cur = e;
  }
  return cur ?? events.find((e) => e.type === "cursor") ?? null;
}

const magick = (...args: string[]) => execFileSync("magick", args, { encoding: "utf8" }).trim();
/** An image region as [w, h, x, y] from ImageMagick's %@ ("WxH+X+Y"). */
const bbox = (s: string) => s.match(/\d+/g)!.map(Number) as [number, number, number, number];

/** Source seconds for output seconds, through the idle speed-up's segments ([start, end, speed] in source time). */
function timeMap(segments: [number, number, number][]) {
  let u0 = 0;
  const spans = segments.map(([a, b, k]) => {
    const span = { a, b, k, u0, u1: u0 + (b - a) / k };
    u0 = span.u1;
    return span;
  });
  return {
    length: u0,
    source: (u: number) => {
      const sp = spans.find((x) => u <= x.u1) ?? spans.at(-1)!;
      return Math.min(sp.b, sp.a + (u - sp.u0) * sp.k);
    },
    output: (s: number) => {
      const sp = spans.find((x) => s <= x.b) ?? spans.at(-1)!;
      return sp.u0 + (Math.max(s, sp.a) - sp.a) / sp.k;
    },
  };
}

/** The canvas the window sits on: 16:10, the window centred (a little high: the shadow falls below), px. */
function canvasOf(meta: Meta, o: PostOptions) {
  const cw = even(meta.width / (o.fill ?? 0.82));
  const ch = even(cw * 0.625);
  const cx = Math.round((cw - meta.width) / 2);
  const cy = Math.round((ch - meta.height) / 2 - meta.height * 0.012);
  return { cw, ch, cx, cy, toCanvas: (p: { x: number; y: number }) => ({ x: cx + (p.x - meta.rect.x) * meta.scale, y: cy + (p.y - meta.rect.y) * meta.scale }) };
}

/** Seconds of a clip's end crossfaded into its start, so it loops without a seam. */
const LOOP_FADE = 0.35;
/** A shot's crop is never smaller than this share of its output width (more would upscale and blur). */
const SHOT_MIN = 1 / 1.2;

export interface Clip {
  name: string;
  file: string;
  webm: string;
  poster: string;
  width: number;
  height: number;
  seconds: number;
  loop: boolean;
  /** How different the shot's first and last frames are (0 = same); a loop wants it small. */
  seam: number;
}

const probeSeconds = (file: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());

/**
 * The tour's shots (t.shot): each its own clip, framed on the UI it named (the
 * union of its logged boxes, padded, at its aspect ratio), looped seamlessly if
 * asked, as .mp4 (H.264), .webm (VP9) and a poster, listed in clips/clips.json.
 */
export function renderShots(dir: string, o: PostOptions = {}, width = 1080): Clip[] {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as Meta & { name?: string };
  const events = (JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8")) as (Ev & { name?: string; phase?: string; pad?: number; aspect?: number; loop?: boolean; framing?: string })[]).sort((a, b) => a.t - b.t);
  const { toCanvas } = canvasOf(meta, o);
  const S = meta.scale;
  const sec = (t: number) => (t - meta.t0) / 1e9;
  const duration = (meta.t1 - meta.t0) / 1e9;
  const clipsDir = path.join(dir, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });
  const clips: Clip[] = [];
  for (const start of events.filter((e) => e.type === "shot" && e.phase === "start")) {
    const name = start.name!;
    const end = events.find((e) => e.type === "shot" && e.phase === "end" && e.name === name && e.t > start.t);
    const a = sec(start.t), b = end ? sec(end.t) : duration;
    const boxes = events.filter((e) => e.type === "shot-box" && e.name === name && e.t >= start.t && (!end || e.t <= end.t) && e.rect);
    if (!boxes.length) {
      console.warn(`shot ${name}: its region never showed up, skipped`);
      continue;
    }
    // Framed on the box the region kept longest (a palette mostly shows a filtered list; its tall
    // unfiltered one flashes by), or with framing: "union", on everything it covered. Canvas px.
    const rects = boxes.map((e, i) => ({
      ...toCanvas({ x: e.rect![0]!, y: e.rect![1]! }),
      w: e.rect![2]! * S,
      h: e.rect![3]! * S,
      held: ((boxes[i + 1]?.t ?? end?.t ?? meta.t1) - e.t) / 1e9,
    }));
    const framed = start.framing === "union" ? rects : [rects.reduce((a, r) => (r.held > a.held ? r : a))];
    const x0 = Math.min(...framed.map((r) => r.x)), y0 = Math.min(...framed.map((r) => r.y));
    const x1 = Math.max(...framed.map((r) => r.x + r.w)), y1 = Math.max(...framed.map((r) => r.y + r.h));
    const pad = (start.pad ?? 40) * S;
    const aspect = start.aspect ?? 1;
    const height = even(width / aspect);
    let w = Math.max(x1 - x0 + 2 * pad, (y1 - y0 + 2 * pad) * aspect, width * SHOT_MIN);
    const h = w / aspect;
    w = h * aspect;
    const view = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
    const base = `${meta.name ?? path.basename(dir)}-${name}`;
    const plain = path.join(clipsDir, `${base}.plain.mp4`);
    render(dir, o, { span: [Math.max(0, a - 0.1), Math.min(duration, b + 0.1)], view, width, height, out: plain });
    const file = path.join(clipsDir, `${base}.mp4`);
    // How far the end is from the start (mean difference of the two frames, 0–1).
    const seconds0 = probeSeconds(plain);
    const frameAt = (t: number, out: string) => execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, t)), "-i", plain, "-frames:v", "1", "-vf", "scale=240:-1", out]);
    const f0 = path.join(clipsDir, `${base}.first.png`), f1 = path.join(clipsDir, `${base}.last.png`);
    frameAt(0, f0);
    frameAt(seconds0 - 0.05, f1);
    const seam = Number(spawnSync("magick", ["compare", "-metric", "RMSE", f0, f1, "null:"], { encoding: "utf8" }).stderr.match(/\(([\d.]+)\)/)?.[1] ?? 1);
    fs.rmSync(f1, { force: true });
    const loop = start.loop !== false;
    if (loop && seconds0 > LOOP_FADE * 3) {
      if (seam > 0.08) console.warn(`shot ${name}: its last frame looks quite different from its first (${seam.toFixed(2)}): end it where it started (t.loopBack, close what opened)`);
      // The body after the first LOOP_FADE s, its end crossfaded into those first frames: seamless.
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", plain, "-filter_complex",
        `[0]split[a][b];[a]trim=0:${LOOP_FADE},setpts=PTS-STARTPTS[head];[b]trim=${LOOP_FADE},setpts=PTS-STARTPTS[body];[body][head]xfade=transition=fade:duration=${LOOP_FADE}:offset=${(seconds0 - 2 * LOOP_FADE).toFixed(3)},format=yuv420p[v]`,
        "-map", "[v]", "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-movflags", "+faststart", file]);
      fs.rmSync(plain, { force: true });
    } else fs.renameSync(plain, file);
    const webm = path.join(clipsDir, `${base}.webm`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1", webm]);
    // The poster is the finished clip's first frame (after a loop's crossfade it isn't the plain one's).
    const poster = path.join(clipsDir, `${base}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-frames:v", "1", poster]);
    fs.rmSync(f0, { force: true });
    clips.push({ name, file, webm, poster, width, height, seconds: probeSeconds(file), loop, seam: Math.round(seam * 1000) / 1000 });
  }
  if (clips.length) fs.writeFileSync(path.join(clipsDir, "clips.json"), JSON.stringify(clips.map((c) => ({ ...c, file: path.basename(c.file), webm: path.basename(c.webm), poster: path.basename(c.poster) })), null, 1));
  return clips;
}

/** A shot to render instead of the whole tour: its source span, a fixed view (canvas px), its output size and file. */
interface ShotRender {
  span: [number, number];
  view: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  out: string;
}

export function render(dir: string, o: PostOptions = {}, shot?: ShotRender): string {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as Meta;
  const events = (JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8")) as Ev[]).sort((a, b) => a.t - b.t);
  const work = path.join(dir, "post");
  fs.mkdirSync(work, { recursive: true });
  const S = meta.scale;

  // The window and its shadow in the still: the opaque part is the window (its
  // exact shape), anything with alpha is window or shadow.
  const still = path.join(dir, "window.png");
  const [ww, wh, wx, wy] = bbox(magick(still, "-alpha", "extract", "-threshold", "99%", "-format", "%@", "info:"));
  const [sw, sh, sx, sy] = bbox(magick(still, "-alpha", "extract", "-threshold", "0.5%", "-format", "%@", "info:"));
  const shadow = path.join(work, "shadow.png");
  const mask = path.join(work, "mask.png");
  magick(still, "-crop", `${sw}x${sh}+${sx}+${sy}`, "+repage", shadow);
  magick(still, "-crop", `${ww}x${wh}+${wx}+${wy}`, "+repage", "-alpha", "extract", "-resize", `${meta.width}x${meta.height}!`, mask);

  const { cw, ch, cx, cy } = canvasOf(meta, o);
  // The desk the window sits on: three canvases each way, the canvas in the middle, so the
  // camera finds background wherever it goes (the renderer extends it beyond that too).
  const wall = path.join(work, "wallpaper.png");
  const desk = { x: -cw, y: -ch, w: cw * 3, h: ch * 3 };
  const deskPx = `${Math.round(desk.w / 2)}x${Math.round(desk.h / 2)}`; // half resolution: it's a soft gradient
  if (o.wallpaper) magick(o.wallpaper, "-resize", `${deskPx}^`, "-gravity", "center", "-extent", deskPx, wall);
  // Made in 16 bits and dithered with a little noise: a slow 8-bit gradient shows steps (bands) once zoomed in.
  else magick("-size", deskPx, "-depth", "16", "-define", "gradient:angle=135", "gradient:#0d1422-#3d6390", "-attenuate", "0.22", "+noise", "Gaussian", "-depth", "8", wall);

  // Cursor shapes: the real ones the helper saved, at their size on screen (×S px).
  const shapes = new Map<number, Ev>();
  for (const e of events) if (e.type === "cursor" && !shapes.has(e.id!)) shapes.set(e.id!, e);
  const k = o.cursor ?? 1;
  const cursors: Record<string, { path: string; w: number; h: number; hx: number; hy: number }> = {};
  for (const [id, e] of shapes) {
    const file = path.join(dir, "cursors", `cursor-${id}.png`);
    if (fs.existsSync(file)) cursors[id] = { path: file, w: e.w! * S * k, h: e.h! * S * k, hx: e.hx! * S * k, hy: e.hy! * S * k };
  }
  const fallback = !Object.keys(cursors).length;
  if (fallback) {
    // No shapes logged (an older run): our own arrow.
    const file = path.join(work, "cursor.png");
    execFileSync("rsvg-convert", ["-z", String(S * k * 4), "-o", file, path.join(ASSETS, "cursor.svg")]);
    cursors["0"] = { path: file, w: 28 * S * k, h: 36 * S * k, hx: 3 * S * k, hy: 3 * S * k };
  }
  const ring = o.clicks ? path.join(work, "click.png") : null;
  if (ring) execFileSync("rsvg-convert", ["-z", String(S), "-o", ring, path.join(ASSETS, "click.svg")]);

  // Time: output seconds map to source seconds (waiting sped up, if asked).
  const duration = (meta.t1 - meta.t0) / 1e9;
  const inputs = events.filter((e) => !["cursor", "camera", "hold", "typing"].includes(e.type)).map((e) => (e.t - meta.t0) / 1e9);
  const frozen = o.tighten !== false ? frozenStretches(path.join(dir, "raw.mov"), duration) : [];
  // Deliberate pauses (t.pause), kept whole.
  const holds = events.filter((e) => e.type === "hold").map((e) => {
    const a = (e.t - meta.t0) / 1e9;
    return [a, a + (e.ms ?? 0) / 1000] as [number, number];
  });
  let segments = timeSegments(inputs, frozen, duration, { idle: o.idle, tighten: o.tighten, holds });
  // A shot: only its span of the recording.
  if (shot) segments = segments.map(([a, b, k]): [number, number, number] => [Math.max(a, shot.span[0]), Math.min(b, shot.span[1]), k]).filter(([a, b]) => b - a > 1e-6);
  const time = timeMap(segments.length ? segments : [[0, duration, 1]]);
  const frames = Math.floor(time.length * FPS) + 1;
  const sec = (e: Ev) => (e.t - meta.t0) / 1e9;
  const toCanvas = (p: { x: number; y: number }) => ({ x: cx + (p.x - meta.rect.x) * S, y: cy + (p.y - meta.rect.y) * S });
  const pointer = (s: number) => {
    const p = pointerAt(events, meta.t0 + s * 1e9);
    return p ? toCanvas(p) : null;
  };

  // The camera (camera.ts), in output time so its springs stay smooth through sped-up stretches.
  const marks: CameraMark[] = events
    .filter((e) => e.type === "camera")
    .map((e) => {
      const r = e.rect ? toCanvas({ x: e.rect[0]!, y: e.rect[1]! }) : null;
      return { s: time.output(sec(e)), mode: e.mode!, zoom: e.zoom, rect: r ? { x: r.x, y: r.y, w: e.rect![2]! * S, h: e.rect![3]! * S } : undefined };
    });
  if (o.follow) marks.unshift({ s: 0, mode: "follow", zoom: o.follow });
  if (o.camera === "auto" && !marks.length)
    marks.push(
      ...autoCamera(
        events.map((e) => {
          const r = e.type === "typing" && e.rect ? toCanvas({ x: e.rect[0]!, y: e.rect[1]! }) : null;
          return { s: time.output(sec(e)), type: e.type, rect: r ? { x: r.x, y: r.y, w: e.rect![2]! * S, h: e.rect![3]! * S } : undefined };
        }),
        time.length,
      ),
    );
  const views = shot ? null : marks.length ? cameraPath(frames, FPS, { w: cw, h: ch }, marks, (u) => pointer(time.source(u))) : null;

  // The plan: per output frame, what to show where (helper/render.swift draws it).
  const presses = events.filter((e) => e.type === "down").map(sec);
  const rows: number[][] = [];
  for (let n = 0; n < frames; n++) {
    const u = n / FPS;
    const s = time.source(u);
    const v = shot?.view ?? views?.[n] ?? { x: 0, y: 0, w: cw, h: ch };
    const p = pointer(s);
    const shape = fallback ? 0 : (cursorAt(events, meta.t0 + s * 1e9)?.id ?? -1);
    const c = cursors[shape];
    const press = ring ? presses.find((ps) => s >= ps && s < ps + RING_MS / 1000) : undefined;
    const pp = press !== undefined ? pointer(press) : null;
    rows.push([
      s, v.x, v.y, v.w, v.h,
      p && c ? shape : -1, p && c ? p.x - c.hx : 0, p && c ? p.y - c.hy : 0,
      pp ? pp.x : 0, pp ? pp.y : 0, pp && press !== undefined ? 1 - (s - press) / (RING_MS / 1000) : 0,
    ].map((x) => Math.round(x * 1000) / 1000));
  }
  const outW = shot?.width ?? even(o.width ?? 2560);
  const outH = shot?.height ?? even((outW * ch) / cw);
  const plan = {
    fps: FPS,
    width: outW,
    height: outH,
    canvas: [cw, ch],
    video: path.join(dir, "raw.mov"),
    videoSize: [meta.width, meta.height],
    videoFrames: frameTimes(path.join(dir, "raw.mov")),
    window: [cx, cy, meta.width, meta.height],
    mask,
    wallpaper: { path: wall, ...desk },
    shadow: { path: shadow, x: cx - (wx - sx), y: cy - (wy - sy) },
    cursors: Object.fromEntries(Object.entries(cursors).map(([id, c]) => [id, { path: c.path, w: c.w, h: c.h }])),
    ring,
    frames: rows,
  };
  const planFile = path.join(work, shot ? `plan-${path.basename(shot.out, ".mp4")}.json` : "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const out = shot?.out ?? path.join(dir, "tour.mp4");
  execFileSync(buildRenderer(), [planFile, out], { stdio: ["ignore", "ignore", "inherit"] });
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.log("usage: node packages/tours/src/post.ts <run dir> [--wallpaper img] [--cursor 1.0] [--clicks] [--idle 4] [--width 1920] [--follow 1.6] [--auto-camera] [--real-time]");
    process.exit(2);
  }
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  console.log(render(path.resolve(dir), { wallpaper: opt("--wallpaper"), cursor: opt("--cursor") ? Number(opt("--cursor")) : undefined, clicks: args.includes("--clicks"), idle: opt("--idle") ? Number(opt("--idle")) : undefined, width: opt("--width") ? Number(opt("--width")) : undefined, follow: opt("--follow") ? Number(opt("--follow")) : undefined, camera: args.includes("--auto-camera") ? "auto" : undefined, tighten: !args.includes("--real-time") }));
}

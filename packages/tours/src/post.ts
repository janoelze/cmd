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
//   node packages/tours/src/post.ts <run dir> [--wallpaper img] [--cursor 1.0] [--clicks] [--idle 4] [--width 1920] [--follow 1.6] [--auto-camera]
//
// No smoothing: the driver's paths are already human; a real recording has none.

import { execFileSync } from "node:child_process";
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
  /** Follow the pointer the whole video at this zoom (tours mark the camera with t.camera instead). */
  follow?: number;
  /** "auto": zoom in on bursts of clicking and typing, whole window while scrolling (camera.ts autoCamera); a tour's own t.camera marks win. */
  camera?: "auto";
}

/** Input-free stretches longer than this are sped up (with `idle`), seconds. */
const IDLE_FROM = 3;
/** Real-time time kept at each end of a sped-up stretch, seconds. */
const IDLE_KEEP = 0.9;

/** The video's segments [start, end, speed] (seconds): input-free stretches sped up, the rest real-time. */
export function idleSegments(events: { t: number; type: string }[], t0: number, duration: number, speed: number): [number, number, number][] {
  const inputs = events.filter((e) => e.type !== "cursor").map((e) => (e.t - t0) / 1e9).filter((t) => t >= 0 && t <= duration);
  const marks = [0, ...inputs, duration];
  const out: [number, number, number][] = [];
  let at = 0;
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1]!, b = marks[i]!;
    if (b - a < IDLE_FROM) continue;
    const fastFrom = a + IDLE_KEEP, fastTo = b - IDLE_KEEP;
    if (fastFrom > at) out.push([at, fastFrom, 1]);
    out.push([fastFrom, fastTo, speed]);
    at = fastTo;
  }
  if (at < duration) out.push([at, duration, 1]);
  return out.filter(([a, b]) => b - a > 0.02);
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

export function render(dir: string, o: PostOptions = {}): string {
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

  // The canvas: 16:10, the window centred (a little high: the shadow falls below).
  const cw = even(meta.width / (o.fill ?? 0.82));
  const ch = even(cw * 0.625);
  const cx = Math.round((cw - meta.width) / 2);
  const cy = Math.round((ch - meta.height) / 2 - meta.height * 0.012);
  const wall = path.join(work, "wallpaper.png");
  if (o.wallpaper) magick(o.wallpaper, "-resize", `${cw}x${ch}^`, "-gravity", "center", "-extent", `${cw}x${ch}`, wall);
  else magick("-size", `${cw}x${ch}`, "-define", "gradient:angle=135", "gradient:#141e30-#35577d", wall);

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
  const segments = o.idle && o.idle > 1 ? idleSegments(events, meta.t0, duration, o.idle) : [[0, duration, 1] as [number, number, number]];
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
  if (o.camera === "auto" && !marks.length) marks.push(...autoCamera(events.map((e) => ({ s: time.output(sec(e)), type: e.type })), time.length));
  // Zoomed in, the camera stays on the window (a 24 px margin), not on the wallpaper around it.
  const m = 24 * S;
  const views = marks.length
    ? cameraPath(frames, FPS, { w: cw, h: ch }, marks, (u) => pointer(time.source(u)), undefined, { x: cx - m, y: cy - m, w: meta.width + 2 * m, h: meta.height + 2 * m })
    : null;

  // The plan: per output frame, what to show where (helper/render.swift draws it).
  const presses = events.filter((e) => e.type === "down").map(sec);
  const rows: number[][] = [];
  for (let n = 0; n < frames; n++) {
    const u = n / FPS;
    const s = time.source(u);
    const v = views?.[n] ?? { x: 0, y: 0, w: cw, h: ch };
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
  const outW = even(o.width ?? 2560);
  const outH = even((outW * ch) / cw);
  const plan = {
    fps: FPS,
    width: outW,
    height: outH,
    canvas: [cw, ch],
    video: path.join(dir, "raw.mov"),
    window: [cx, cy, meta.width, meta.height],
    mask,
    wallpaper: wall,
    shadow: { path: shadow, x: cx - (wx - sx), y: cy - (wy - sy) },
    cursors: Object.fromEntries(Object.entries(cursors).map(([id, c]) => [id, { path: c.path, w: c.w, h: c.h }])),
    ring,
    frames: rows,
  };
  const planFile = path.join(work, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const out = path.join(dir, "tour.mp4");
  execFileSync(buildRenderer(), [planFile, out], { stdio: ["ignore", "ignore", "inherit"] });
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.log("usage: node packages/tours/src/post.ts <run dir> [--wallpaper img] [--cursor 1.0] [--clicks] [--idle 4] [--width 1920] [--follow 1.6] [--auto-camera]");
    process.exit(2);
  }
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  console.log(render(path.resolve(dir), { wallpaper: opt("--wallpaper"), cursor: opt("--cursor") ? Number(opt("--cursor")) : undefined, clicks: args.includes("--clicks"), idle: opt("--idle") ? Number(opt("--idle")) : undefined, width: opt("--width") ? Number(opt("--width")) : undefined, follow: opt("--follow") ? Number(opt("--follow")) : undefined, camera: args.includes("--auto-camera") ? "auto" : undefined }));
}

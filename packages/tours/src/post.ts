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
//   node packages/tours/src/post.ts <run dir> [--wallpaper img] [--cursor 1.0] [--clicks] [--idle 4]
//
// No smoothing: the driver's paths are already human; a real recording has none.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Ev {
  t: number;
  type: string;
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
  const cursorInputs: { id: number; file: string; w: number; h: number; hx: number; hy: number }[] = [];
  for (const [id, e] of shapes) {
    const file = path.join(dir, "cursors", `cursor-${id}.png`);
    if (fs.existsSync(file)) cursorInputs.push({ id, file, w: even(e.w! * S * k), h: even(e.h! * S * k), hx: e.hx! * S * k, hy: e.hy! * S * k });
  }
  if (!cursorInputs.length) {
    // No shapes logged (an older run): our own arrow.
    const file = path.join(work, "cursor.png");
    execFileSync("rsvg-convert", ["-z", String(S * k), "-o", file, path.join(ASSETS, "cursor.svg")]);
    cursorInputs.push({ id: -1, file, w: even(28 * S * k), h: even(36 * S * k), hx: 3 * S * k, hy: 3 * S * k });
  }

  // Per frame: each cursor overlay where the pointer is if it's the shape shown, else off canvas.
  const toCanvas = (p: { x: number; y: number }) => ({ x: cx + (p.x - meta.rect.x) * S, y: cy + (p.y - meta.rect.y) * S });
  const lines: string[] = [];
  const last = new Map<number, string>();
  const duration = (meta.t1 - meta.t0) / 1e9;
  for (let i = 0; i / FPS <= duration; i++) {
    const s = i / FPS;
    const t = meta.t0 + s * 1e9;
    const p = pointerAt(events, t);
    const shown = cursorInputs.length === 1 ? cursorInputs[0]!.id : (cursorAt(events, t)?.id ?? cursorInputs[0]!.id);
    for (const c of cursorInputs) {
      let pos = "-9999 -9999";
      if (p && c.id === shown) {
        const v = toCanvas(p);
        pos = `${Math.round(v.x - c.hx)} ${Math.round(v.y - c.hy)}`;
      }
      if (last.get(c.id) === pos) continue;
      last.set(c.id, pos);
      const [x, y] = pos.split(" ");
      lines.push(`${s.toFixed(4)} [enter] overlay@c${c.id < 0 ? "x" : c.id} x ${x}, [enter] overlay@c${c.id < 0 ? "x" : c.id} y ${y};`);
    }
  }
  const presses = events.filter((e) => e.type === "down");
  const ring = path.join(work, "click.png");
  const ringSize = 64 * S;
  if (o.clicks) {
    execFileSync("rsvg-convert", ["-z", String(S), "-o", ring, path.join(ASSETS, "click.svg")]);
    for (const e of presses) {
      const v = toCanvas({ x: e.x!, y: e.y! });
      lines.push(`${Math.max(0, (e.t - meta.t0) / 1e9 - 0.001).toFixed(4)} [enter] overlay@ring x ${Math.round(v.x - ringSize / 2)}, [enter] overlay@ring y ${Math.round(v.y - ringSize / 2)};`);
    }
  }
  lines.sort((a, b) => parseFloat(a) - parseFloat(b));
  const cmds = path.join(work, "pointer.cmd");
  fs.writeFileSync(cmds, lines.join("\n") + "\n");

  // The graph. The looped images never end on their own: -t stops at the recording's length.
  const inputs = ["-loop", "1", "-i", wall, "-loop", "1", "-i", shadow, "-i", path.join(dir, "raw.mov"), "-loop", "1", "-i", mask];
  const g: string[] = [
    `[2:v]fps=${FPS},sendcmd=f='${cmds}',format=rgba[v]`,
    `[3:v]format=gray[m]`,
    `[v][m]alphamerge[win]`,
    `[0:v][1:v]overlay=x=${cx - (wx - sx)}:y=${cy - (wy - sy)}[bg]`,
    `[bg][win]overlay=x=${cx}:y=${cy}:shortest=1[k]`,
  ];
  let label = "k";
  let n = 4;
  if (o.clicks) {
    inputs.push("-loop", "1", "-i", ring);
    const shownAt = presses.map((e) => `between(t,${((e.t - meta.t0) / 1e9).toFixed(3)},${((e.t - meta.t0) / 1e9 + RING_MS / 1000).toFixed(3)})`).join("+") || "0";
    g.push(`[${label}][${n}:v]overlay@ring=x=-9999:y=-9999:enable='${shownAt}'[r]`);
    label = "r";
    n++;
  }
  for (const c of cursorInputs) {
    inputs.push("-loop", "1", "-i", c.file);
    const name = `c${c.id < 0 ? "x" : c.id}`;
    g.push(`[${n}:v]scale=${c.w}:${c.h}:flags=lanczos,format=rgba[${name}i]`);
    g.push(`[${label}][${name}i]overlay@${name}=x=-9999:y=-9999[${name}o]`);
    label = `${name}o`;
    n++;
  }
  const outW = even(o.width ?? 2560);
  g.push(`[${label}]scale=${outW}:-2:flags=lanczos,format=yuv420p[scaled]`);
  let length = duration;
  const segments = o.idle && o.idle > 1 ? idleSegments(events, meta.t0, duration, o.idle) : [];
  if (segments.some(([, , k]) => k > 1)) {
    // Cut into segments, play the idle ones faster, join them, back to a steady frame rate.
    g.push(`[scaled]split=${segments.length}${segments.map((_, i) => `[p${i}]`).join("")}`);
    segments.forEach(([a, b, k], i) => g.push(`[p${i}]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${k}[q${i}]`));
    g.push(`${segments.map((_, i) => `[q${i}]`).join("")}concat=n=${segments.length}:v=1:a=0,fps=${FPS}[out]`);
    length = segments.reduce((n, [a, b, k]) => n + (b - a) / k, 0);
  } else g.push(`[scaled]null[out]`);

  const out = path.join(dir, "tour.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", g.join(";"), "-map", "[out]", "-t", length.toFixed(3), "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "15", "-movflags", "+faststart", out], { stdio: "inherit" });
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.log("usage: node packages/tours/src/post.ts <run dir> [--wallpaper img] [--cursor 1.0] [--clicks]");
    process.exit(2);
  }
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  console.log(render(path.resolve(dir), { wallpaper: opt("--wallpaper"), cursor: opt("--cursor") ? Number(opt("--cursor")) : undefined, clicks: args.includes("--clicks"), idle: opt("--idle") ? Number(opt("--idle")) : undefined }));
}

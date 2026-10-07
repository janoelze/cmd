// Post, first pass: draws the pointer onto a recording from its event log.
// The recording has no cursor (the helper hides it); the log says exactly where
// the pointer was, on the frames' clock. For every output frame (constant 60
// fps) the pointer's position is interpolated from the logged moves and fed to
// ffmpeg's overlay with sendcmd; clicks get a ring for a moment.
//   node packages/tours/src/post.ts <run dir>  → preview.mp4
// Smoothing, zoom and the window's frame and background come later.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Ev {
  t: number;
  type: string;
  x?: number;
  y?: number;
}
interface Meta {
  rect: { x: number; y: number; width: number; height: number };
  scale: number;
  t0: number;
  t1: number;
}

const ASSETS = path.join(import.meta.dirname, "..", "assets");
const FPS = 60;
/** Pointer size on video: points × this (the system arrow is about 1×; videos read better larger). */
const CURSOR = 1.6;
/** Where the arrow's tip is in cursor.svg, in its own units. */
const TIP = { x: 3, y: 3 };
const RING_MS = 280;

/** The pointer's position (screen points) at a time (ns), from the logged moves and presses. */
export function pointerAt(events: Ev[], t: number): { x: number; y: number } | null {
  let prev: Ev | null = null;
  for (const e of events) {
    if (e.x === undefined || e.y === undefined) continue;
    if (e.t >= t) {
      if (!prev) return { x: e.x, y: e.y };
      const f = (t - prev.t) / (e.t - prev.t || 1);
      // Interpolate only within a move (events close together); otherwise the pointer rests.
      if (e.t - prev.t > 50e6) return { x: prev.x!, y: prev.y! };
      return { x: prev.x! + (e.x - prev.x!) * f, y: prev.y! + (e.y - prev.y!) * f };
    }
    prev = e;
  }
  return prev ? { x: prev.x!, y: prev.y! } : null;
}

export function renderPreview(dir: string) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as Meta;
  const events = (JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8")) as Ev[]).sort((a, b) => a.t - b.t);
  const work = path.join(dir, "post");
  fs.mkdirSync(work, { recursive: true });
  const px = meta.scale * CURSOR;
  const cursor = path.join(work, "cursor.png");
  const ring = path.join(work, "click.png");
  execFileSync("rsvg-convert", ["-z", String(px), "-o", cursor, path.join(ASSETS, "cursor.svg")]);
  execFileSync("rsvg-convert", ["-z", String(meta.scale), "-o", ring, path.join(ASSETS, "click.svg")]);
  const toVideo = (p: { x: number; y: number }) => ({ x: (p.x - meta.rect.x) * meta.scale, y: (p.y - meta.rect.y) * meta.scale });

  // One command line per frame: where the cursor image goes (its tip on the pointer).
  const duration = (meta.t1 - meta.t0) / 1e9;
  const lines: string[] = [];
  for (let i = 0; i * (1 / FPS) <= duration; i++) {
    const s = i / FPS;
    const p = pointerAt(events, meta.t0 + s * 1e9);
    if (!p) continue;
    const v = toVideo(p);
    lines.push(`${s.toFixed(4)} [enter] overlay@cursor x ${Math.round(v.x - TIP.x * px)}, [enter] overlay@cursor y ${Math.round(v.y - TIP.y * px)};`);
  }
  // Rings: each press moves the ring there; it shows for RING_MS.
  const presses = events.filter((e) => e.type === "down");
  const ringSize = 64 * meta.scale;
  for (const e of presses) {
    const s = (e.t - meta.t0) / 1e9;
    const v = toVideo({ x: e.x!, y: e.y! });
    lines.push(`${Math.max(0, s - 0.001).toFixed(4)} [enter] overlay@ring x ${Math.round(v.x - ringSize / 2)}, [enter] overlay@ring y ${Math.round(v.y - ringSize / 2)};`);
  }
  lines.sort((a, b) => parseFloat(a) - parseFloat(b));
  const cmds = path.join(work, "pointer.cmd");
  fs.writeFileSync(cmds, lines.join("\n") + "\n");
  const shown = presses.map((e) => `between(t,${((e.t - meta.t0) / 1e9).toFixed(3)},${((e.t - meta.t0) / 1e9 + RING_MS / 1000).toFixed(3)})`).join("+") || "0";

  const out = path.join(dir, "preview.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v", "error", "-y",
      "-i", path.join(dir, "raw.mov"),
      "-loop", "1", "-i", ring,
      "-loop", "1", "-i", cursor,
      "-filter_complex",
      `[0:v]fps=${FPS},sendcmd=f='${cmds}'[base];` +
        `[base][1:v]overlay@ring=x=-1000:y=-1000:enable='${shown}':shortest=1[ringed];` +
        `[ringed][2:v]overlay@cursor=x=-1000:y=-1000:shortest=1,format=yuv420p[v]`,
      "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-movflags", "+faststart", out,
    ],
    { stdio: "inherit" },
  );
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2];
  if (!dir) {
    console.log("usage: node packages/tours/src/post.ts <run dir>");
    process.exit(2);
  }
  console.log(renderPreview(path.resolve(dir)));
}

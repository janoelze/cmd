// The video's camera: from the tour's camera marks (and the pointer, when
// following it), a view per frame into the composited canvas, which post crops
// to and scales back up. Moves are critically damped springs (no overshoot,
// settled in about 0.6 s), zoom springs in log space so zooming in and out feel
// the same, and the view never leaves the canvas. Following the pointer has a
// dead zone: the view drifts only when the pointer nears its edge, as a camera
// operator would, rather than shaking along with every move.

export interface CameraMark {
  /** Seconds into the video. */
  s: number;
  mode: "fit" | "focus" | "follow";
  /** focus: the place, in canvas px. */
  rect?: { x: number; y: number; w: number; h: number };
  zoom?: number;
}

export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CAMERA = {
  /** Spring stiffness for moving and zooming (ω, rad/s): higher settles faster. */
  move: 5.5,
  zoom: 4.5,
  maxZoom: 3,
  /** A focused place fills the view up to 1/room of its size. */
  room: 1.6,
  /** Following: the pointer may wander this share of the view from its centre before the view moves. */
  deadZone: 0.22,
};
export type CameraConfig = typeof CAMERA;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * One view per frame. `pointer(s)` is the pointer in canvas px at a time
 * (seconds), null before it's known. Marks must be sorted by time.
 */
export function cameraPath(
  frames: number,
  fps: number,
  canvas: { w: number; h: number },
  marks: CameraMark[],
  pointer: (s: number) => { x: number; y: number } | null,
  c: CameraConfig = CAMERA,
  /** Zoomed in, the view stays inside this (the window and a small margin: not the wallpaper). */
  inside: View = { x: 0, y: 0, w: canvas.w, h: canvas.h },
): View[] {
  const { w: cw, h: ch } = canvas;
  let cx = cw / 2, cy = ch / 2, lz = 0;
  let vx = 0, vy = 0, vz = 0;
  // Following: where the view aims, moved only as far as the dead zone needs.
  let aimX = cw / 2, aimY = ch / 2;
  let mi = -1;
  const out: View[] = [];
  const sub = 4;
  for (let i = 0; i < frames; i++) {
    const s = i / fps;
    while (mi + 1 < marks.length && marks[mi + 1]!.s <= s) {
      mi++;
      // A new mark: following starts from where the view is.
      if (marks[mi]!.mode === "follow") (aimX = cx), (aimY = cy);
    }
    const m = mi >= 0 ? marks[mi]! : null;
    let tx = cw / 2, ty = ch / 2, tz = 1;
    if (m?.mode === "focus" && m.rect) {
      tz = m.zoom ?? Math.min(cw / (m.rect.w * c.room), ch / (m.rect.h * c.room));
      tx = m.rect.x + m.rect.w / 2;
      ty = m.rect.y + m.rect.h / 2;
    } else if (m?.mode === "follow") {
      tz = m.zoom ?? 1.6;
      const p = pointer(s);
      if (p) {
        const hw = (cw / tz) * c.deadZone, hh = (ch / tz) * c.deadZone;
        aimX = clamp(aimX, p.x - hw, p.x + hw);
        aimY = clamp(aimY, p.y - hh, p.y + hh);
      }
      tx = aimX;
      ty = aimY;
    }
    tz = clamp(tz, 1, c.maxZoom);
    // Keep a zoomed view on the window (centred on it if it's wider), the whole view inside the canvas.
    const tw = cw / tz, th = ch / tz;
    if (tz > 1) {
      tx = tw <= inside.w ? clamp(tx, inside.x + tw / 2, inside.x + inside.w - tw / 2) : inside.x + inside.w / 2;
      ty = th <= inside.h ? clamp(ty, inside.y + th / 2, inside.y + inside.h - th / 2) : inside.y + inside.h / 2;
    }
    tx = clamp(tx, tw / 2, cw - tw / 2);
    ty = clamp(ty, th / 2, ch - th / 2);
    const tl = Math.log(tz);
    const dt = 1 / fps / sub;
    for (let k = 0; k < sub; k++) {
      vx += (c.move * c.move * (tx - cx) - 2 * c.move * vx) * dt;
      vy += (c.move * c.move * (ty - cy) - 2 * c.move * vy) * dt;
      vz += (c.zoom * c.zoom * (tl - lz) - 2 * c.zoom * vz) * dt;
      cx += vx * dt;
      cy += vy * dt;
      lz += vz * dt;
    }
    const z = Math.max(1, Math.exp(lz));
    const w = Math.round(cw / z / 2) * 2, h = Math.round(ch / z / 2) * 2;
    out.push({ x: Math.round(clamp(cx - w / 2, 0, cw - w)), y: Math.round(clamp(cy - h / 2, 0, ch - h)), w, h });
  }
  return out;
}

/** An event from the log, as autoCamera needs it: seconds into the video, its type, the pointer. */
export interface CameraInput {
  s: number;
  type: string;
}

export const AUTO = {
  /** Inputs closer than this (s) belong to one burst. */
  burstGap: 2,
  /** Zoom in this long before a burst's first input, and stay this long after its last. */
  lead: 0.45,
  linger: 1.2,
  zoom: 1.5,
  /** Bursts shorter than this (s, a single click) aren't worth a zoom. */
  minBurst: 0.6,
};

/**
 * Camera marks a person editing the video might make: zoom in and follow the
 * pointer while clicking and typing, show the whole window while swiping,
 * scrolling or panning (seeing the layout move is the point), and between
 * bursts of work.
 */
export function autoCamera(inputs: CameraInput[], duration: number, a: typeof AUTO = AUTO): CameraMark[] {
  const marks: CameraMark[] = [];
  const work = inputs.filter((e) => ["down", "char", "key"].includes(e.type)).map((e) => e.s);
  const scrolls = inputs.filter((e) => e.type === "scroll").map((e) => e.s);
  // Bursts of work, split wherever a scroll happens in between.
  const bursts: [number, number][] = [];
  for (const s of work) {
    const b = bursts.at(-1);
    const scrolled = b && scrolls.some((x) => x > b[1] && x < s);
    if (b && s - b[1] < a.burstGap && !scrolled) b[1] = s;
    else bursts.push([s, s]);
  }
  for (const [from, to] of bursts) {
    if (to - from < a.minBurst && !inputs.some((e) => e.type === "char" && e.s >= from && e.s <= to)) continue;
    marks.push({ s: Math.max(0, from - a.lead), mode: "follow", zoom: a.zoom });
    marks.push({ s: Math.min(duration, to + a.linger), mode: "fit" });
  }
  // Scrolling wins: whole window from just before a gesture to its end.
  const gestures: [number, number][] = [];
  for (const s of scrolls) {
    const g = gestures.at(-1);
    if (g && s - g[1] < 0.4) g[1] = s;
    else gestures.push([s, s]);
  }
  const out = marks.filter((m) => !gestures.some(([a0, b0]) => m.s > a0 - 0.3 && m.s < b0 + 0.3));
  for (const [a0, b0] of gestures) {
    out.push({ s: Math.max(0, a0 - 0.3), mode: "fit" });
    // Back to following if a burst was still going on.
    const burst = bursts.find(([f, t]) => f - a.lead < b0 && t + a.linger > b0);
    if (burst) out.push({ s: b0 + 0.3, mode: "follow", zoom: a.zoom });
  }
  return out.sort((x, y) => x.s - y.s);
}

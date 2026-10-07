// Pointer paths that read well on video: one gentle curve per move (a cubic
// Bezier bent to one side), timed by Fitts' law and slowed a little so viewers
// can follow. Speed builds quickly and tapers slowly (peak at ~35–45% of the
// move, like people; a symmetric minimum-jerk peak at 50% looks mechanical),
// and long moves come in two parts: a main move that lands a little short or
// long, then a small correction onto the target (Meyer's submovements). No
// per-step jitter: zoomed in, it reads as tremor.

import { between, clamp, gaussian, lognormal, type Rng } from "./random.ts";

export interface Point {
  x: number;
  y: number;
}

/** A point on a path, `t` ms after the move starts. */
export interface Sample extends Point {
  t: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MOTION = {
  /** Fitts' law fit for a mouse (CHI'20): a + b·log2(D/W + 1), in ms. */
  fittsA: 130,
  fittsB: 157,
  /** Slower than a person, so a viewer can follow. */
  slow: 1.3,
  minMs: 160,
  maxMs: 1400,
  /** Each move's duration varies by this (log-normal sigma). */
  vary: 0.1,
  /** Speed profile τ^(p−1)(1−τ)^(q−1): p = 3 keeps the ends smooth, q in this range puts the peak at ~36–44%. */
  taper: [3.6, 4.6] as [number, number],
  /** Moves longer than this get a correction at the end, px. */
  correctFrom: 250,
  /** Where the main move lands, as a share of the distance past (+) or short of (−) the target. */
  landing: [-0.06, 0.03] as [number, number],
  /** The correction's duration, ms. */
  correctMs: [130, 220] as [number, number],
  /** How far the curve bows out, as a share of the distance, and at most. */
  bend: 0.1,
  maxBend: 120,
  /** Samples per second while moving. */
  hz: 120,
};
export type MotionConfig = typeof MOTION;

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** How long a move of `d` px to a target `w` px wide takes. */
export function moveDuration(d: number, w: number, c: MotionConfig = MOTION): number {
  if (d < 2) return 0;
  return clamp(c.slow * (c.fittsA + c.fittsB * Math.log2(d / Math.max(w, 1) + 1)), c.minMs, c.maxMs);
}

/** Minimum jerk: position share at time share τ. */
export const minJerk = (tau: number) => tau * tau * tau * (10 - 15 * tau + 6 * tau * tau);

/** Position share over time share for speed ∝ τ^(p−1)(1−τ)^(q−1) (q > p: fast start, long taper). */
export function taperProfile(p: number, q: number): (tau: number) => number {
  const N = 400;
  const cum = [0];
  for (let i = 1; i <= N; i++) {
    const t = (i - 0.5) / N;
    cum.push(cum[i - 1]! + t ** (p - 1) * (1 - t) ** (q - 1));
  }
  const total = cum[N]!;
  return (tau) => {
    const x = clamp(tau, 0, 1) * N;
    const i = Math.floor(x);
    if (i >= N) return 1;
    return (cum[i]! + (cum[i + 1]! - cum[i]!) * (x - i)) / total;
  };
}

/** The curve's four control points: both inner ones bent to the same side. */
export function curve(from: Point, to: Point, r: Rng, c: MotionConfig = MOTION): [Point, Point, Point, Point] {
  const d = dist(from, to);
  const nx = -(to.y - from.y) / (d || 1);
  const ny = (to.x - from.x) / (d || 1);
  const side = r() < 0.5 ? -1 : 1;
  const off = side * Math.min(d * c.bend * between(r, 0.5, 1.5), c.maxBend);
  const at = (s: number, k: number) => ({ x: from.x + (to.x - from.x) * s + nx * off * k, y: from.y + (to.y - from.y) * s + ny * off * k });
  return [from, at(0.3, 1), at(0.7, 0.8), to];
}

function bezier([p0, p1, p2, p3]: [Point, Point, Point, Point], s: number): Point {
  const u = 1 - s;
  const a = u * u * u, b = 3 * u * u * s, c = 3 * u * s * s, d = s * s * s;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Samples along the move, evenly in time; long moves end with a small correction. */
export function planMove(from: Point, to: Point, targetWidth: number, r: Rng, c: MotionConfig = MOTION): Sample[] {
  const d = dist(from, to);
  const T = moveDuration(d, targetWidth, c) * (d < 2 ? 1 : lognormal(r, 1, c.vary));
  if (T === 0) return [{ ...to, t: 0 }];
  const profile = taperProfile(3, between(r, ...c.taper));
  if (d < c.correctFrom) return travel(from, to, T, profile, r, c);
  // Main move: lands a little short or long, slightly off the line.
  const along = between(r, ...c.landing);
  const ux = (to.x - from.x) / d, uy = (to.y - from.y) / d;
  const side = clamp(0.012 * d * gaussian(r), -12, 12);
  const land = { x: to.x + ux * along * d - uy * side, y: to.y + uy * along * d + ux * side };
  const main = travel(from, land, T * 0.88, profile, r, c);
  const pause = between(r, 15, 45);
  const fix = travel(land, to, between(r, ...c.correctMs), minJerk, r, { ...c, bend: 0.05 });
  const t0 = main[main.length - 1]!.t + pause;
  return [...main, ...fix.map((s) => ({ ...s, t: s.t + t0 }))];
}

/** One stroke along a bent curve, travelled by arc length with a speed profile. */
function travel(from: Point, to: Point, T: number, profile: (tau: number) => number, r: Rng, c: MotionConfig): Sample[] {
  if (dist(from, to) < 0.5) return [{ ...to, t: T }];
  const ctrl = curve(from, to, r, c);
  // Arc-length table, so speed follows the profile and not the curve's parametrisation.
  const N = 200;
  const pts = Array.from({ length: N + 1 }, (_, i) => bezier(ctrl, i / N));
  const len = [0];
  for (let i = 1; i <= N; i++) len.push(len[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  const total = len[N]!;
  const pointAt = (s: number) => {
    const want = s * total;
    let i = 1;
    while (i < N && len[i]! < want) i++;
    const a = pts[i - 1]!, b = pts[i]!;
    const f = (want - len[i - 1]!) / (len[i]! - len[i - 1]! || 1);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };
  const out: Sample[] = [];
  const step = 1000 / c.hz;
  for (let t = step; t < T; t += step) out.push({ ...pointAt(profile(t / T)), t });
  out.push({ ...to, t: T });
  return out;
}

/**
 * Where to aim in a target: off-centre within its middle 60%, like a person.
 * Wide targets (rows, tree items) are aimed at their start, where the label is.
 */
export function aimAt(b: Box, r: Rng): Point {
  const w = Math.min(b.width, 160);
  const jitter = (n: number) => clamp(0.5 + 0.1 * gaussian(r), 0.2, 0.8) * n;
  return { x: b.x + jitter(w), y: b.y + jitter(b.height) };
}

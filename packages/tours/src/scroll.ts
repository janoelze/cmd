// Trackpad-style scroll gestures that travel an exact distance: a short
// "finger" phase whose speed builds up, then momentum that decays like Apple's
// (velocity × 0.998 per ms). Momentum travels v0 / k (k = −ln 0.998), so the
// starting speed for a distance is solved, not guessed. Deltas are whole
// pixels whose sum is exactly the distance (CGEvent scroll deltas are ints).

export const SCROLL = {
  /** Finger phase length, ms. */
  fingerMs: 150,
  /** Velocity kept per ms during momentum. */
  decay: 0.998,
  /** Fastest fling, px/ms; longer distances take several flings. */
  maxSpeed: 4,
  /** Below this distance, no momentum: a small nudge. */
  nudge: 40,
  /** Pause between flings, ms. */
  between: 120,
  hz: 120,
};
export type ScrollConfig = typeof SCROLL;

export type Phase = "began" | "changed" | "ended" | "momentum-began" | "momentum" | "momentum-ended";

/** One wheel event, `t` ms after the gesture starts. */
export interface WheelStep {
  t: number;
  /** Whole pixels (they sum to the distance). */
  dy: number;
  /** The exact distance of this step: the curve the helper resamples per display refresh. */
  d: number;
  phase: Phase;
}

/** Steps for one fling of `d` px (signed: positive scrolls content up, i.e. down the page). */
function fling(d: number, c: ScrollConfig): { t: number; v: number; phase: Phase }[] {
  const k = -Math.log(c.decay);
  const step = 1000 / c.hz;
  const out: { t: number; v: number; phase: Phase }[] = [];
  if (Math.abs(d) < c.nudge) {
    // Constant-ish speed over the finger phase, no momentum.
    const n = Math.max(2, Math.round(c.fingerMs / step));
    for (let i = 0; i < n; i++) out.push({ t: i * step, v: d / n, phase: i === 0 ? "began" : i === n - 1 ? "ended" : "changed" });
    return out;
  }
  // d = v0·Tf/2 (speeding up linearly) + v0/k (momentum to rest).
  const v0 = d / (c.fingerMs / 2 + 1 / k);
  const n = Math.max(2, Math.round(c.fingerMs / step));
  for (let i = 0; i < n; i++) {
    // Distance covered in this step while speeding up from 0 to v0.
    const a = (i * step) / c.fingerMs, b = ((i + 1) * step) / c.fingerMs;
    out.push({ t: i * step, v: (v0 * c.fingerMs * (b * b - a * a)) / 2, phase: i === 0 ? "began" : i === n - 1 ? "ended" : "changed" });
  }
  const t0 = n * step;
  let t = 0;
  // Distance between t and t+step: (v0/k)(e^{-kt} − e^{-k(t+step)}); stop under ~15 px/s (macOS's momentum
  // ends about there; slower is a long creep of single pixels).
  const momentum: { t: number; v: number; phase: Phase }[] = [];
  for (let first = true; ; first = false) {
    const delta = (v0 / k) * (Math.exp(-k * t) - Math.exp(-k * (t + step)));
    if (Math.abs(delta) < 0.12) break;
    momentum.push({ t: t0 + t, v: delta, phase: first ? "momentum-began" : "momentum" });
    t += step;
  }
  // The tail cut off above, spread over the whole momentum (dumped at the end it was a jump).
  const want = d - out.reduce((a, x) => a + x.v, 0);
  const got = momentum.reduce((a, x) => a + x.v, 0);
  for (const m of momentum) m.v *= got ? want / got : 1;
  out.push(...momentum, { t: t0 + t, v: 0, phase: "momentum-ended" });
  return out;
}

/** A gesture (one or more flings) that scrolls exactly `distance` px. */
export function planScroll(distance: number, c: ScrollConfig = SCROLL): WheelStep[] {
  const d = Math.round(distance);
  if (d === 0) return [];
  const k = -Math.log(c.decay);
  const perFling = c.maxSpeed * (c.fingerMs / 2 + 1 / k);
  const flings = Math.max(1, Math.ceil(Math.abs(d) / perFling));
  const raw: { t: number; v: number; phase: Phase }[] = [];
  let start = 0;
  for (let i = 0; i < flings; i++) {
    const part = fling(d / flings, c);
    for (const s of part) raw.push({ ...s, t: start + s.t });
    start = raw[raw.length - 1]!.t + c.between;
  }
  // Whole pixels, carrying the remainder, so the sum is exactly d.
  const out: WheelStep[] = [];
  let carried = 0;
  let sent = 0;
  for (const s of raw) {
    carried += s.v;
    const px = Math.trunc(carried);
    carried -= px;
    sent += px;
    out.push({ t: s.t, dy: px, d: s.v, phase: s.phase });
  }
  // The momentum tail stops before rest: put what's left in the last moving step.
  const last = [...out].reverse().find((s) => s.dy !== 0 || s.phase === "began")!;
  last.dy += d - sent;
  return out;
}

/** How long a gesture takes, ms. */
export const gestureMs = (steps: WheelStep[]) => steps.at(-1)?.t ?? 0;

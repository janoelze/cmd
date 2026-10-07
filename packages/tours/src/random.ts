// Seeded randomness: the same tour and seed give the same paths, aims and
// typing rhythm, so a re-recording only differs where the app does.

export type Rng = () => number;

/** mulberry32: small, fast, good enough for motion. Returns [0, 1). */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal (Box–Muller). */
export function gaussian(r: Rng): number {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Log-normal around a median: right-skewed like human key intervals. */
export const lognormal = (r: Rng, median: number, sigma: number) => median * Math.exp(sigma * gaussian(r));

export const between = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

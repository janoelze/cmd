// The animation while a Magic window is being made: a grid of dots across the
// window (inset by a margin), barely lighter than the background, with a soft
// band of lighter dots, leaning 25°, sweeping slowly from left to right. One colour, the
// text colour at low opacity (re-read now and then so theme changes apply).
// Static under prefers-reduced-motion.

import { useEffect, useRef } from "react";

const PITCH = 16; // CSS px between dots
const DOT = 2;
const MARGIN = 20;
/** Seconds for one sweep across. */
const PERIOD = 2.8;
/** The band's lean from upright, in radians (it sweeps towards the bottom right). */
const ANGLE = (25 * Math.PI) / 180;
const COS = Math.cos(ANGLE);
const SIN = Math.sin(ANGLE);
/** Opacity of a dot outside the band, and at the band's middle. */
const BASE = 0.07;
const PEAK = 0.3;
/** Opacity steps: dots are batched per step, one fill each. */
const STEPS = 6;

export function DotMatrix({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let color = "";
    const colors = () => {
      color = getComputedStyle(c).getPropertyValue("--text").trim() || "#888";
    };
    const resize = () => {
      const dpr = devicePixelRatio || 1;
      w = c.clientWidth;
      h = c.clientHeight;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const cols = Math.floor((w - 2 * MARGIN) / PITCH) + 1;
      const rows = Math.floor((h - 2 * MARGIN) / PITCH) + 1;
      if (cols < 2 || rows < 2) return;
      const ox = (w - (cols - 1) * PITCH) / 2;
      const oy = (h - (rows - 1) * PITCH) / 2;
      // Position along the sweep's direction; the band is perpendicular to it,
      // leaning ANGLE from upright. Its centre runs from fully off the top-left
      // corner to fully off the bottom-right one.
      const along = (x: number, y: number) => x * COS + y * SIN;
      const band = Math.max(60, w * 0.22);
      const from = along(0, 0) - band;
      const to = along(w, h) + band;
      const centre = from + ((t / PERIOD) % 1) * (to - from);
      const steps = Array.from({ length: STEPS + 1 }, () => new Path2D());
      for (let i = 0; i < cols; i++) {
        const x = ox + i * PITCH;
        for (let j = 0; j < rows; j++) {
          const y = oy + j * PITCH;
          const d = Math.abs(along(x, y) - centre) / band;
          const k = d < 1 ? 0.5 + 0.5 * Math.cos(d * Math.PI) : 0; // smooth falloff
          steps[Math.round(k * STEPS)]!.rect(x - DOT / 2, y - DOT / 2, DOT, DOT);
        }
      }
      ctx.fillStyle = color;
      steps.forEach((p, s) => {
        ctx.globalAlpha = BASE + (PEAK - BASE) * (s / STEPS);
        ctx.fill(p);
      });
      ctx.globalAlpha = 1;
    };

    colors();
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (still) draw(PERIOD / 2);
    });
    ro.observe(c);
    let raf = 0;
    let last = 0;
    let frames = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 33) return; // ~30 fps is plenty for this
      last = now;
      if (++frames % 30 === 0) colors();
      draw((now - t0) / 1000);
    };
    if (still) draw(PERIOD / 2);
    else raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  return <canvas ref={ref} className={className} aria-hidden />;
}

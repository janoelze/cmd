// Numbers as people read them (docs/49 "Pieces"): one formatter per stat unit, shared by the
// CLI and the app (which hands them to the kit's charts). Durations as "3h 12m", counts and
// tokens compact ("1.2K", "2.3M"), bytes in binary steps, deltas as "+18%" or "new". Also the
// app's words for a duration ("7 min") and a project's hue. Widgets get the same functions
// through @cmd/widget-api's `fmt` (`@cmd/protocol/format`), so their text matches the app's.

import type { StatUnit } from "./stats.ts";

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** 3h 12m, 48m, 12s, 120ms; `short`: only the largest unit ("3h"), for axis ticks. */
export function formatDuration(ms: number, short = false): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return short || s % 60 === 0 || m >= 10 ? `${m}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return short || m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return short || h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

export function formatBytes(b: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) (b /= 1024), i++;
  return `${i ? one.format(b) : whole.format(b)} ${units[i]}`;
}

/** 1.2K, 3.4M, 2.1B: the same letters in every locale (Intl's compact notation varies: "1.7m", "1,7 Mio."). */
export function formatCompact(v: number): string {
  const a = Math.abs(v);
  const [d, s] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  const x = v / d;
  return `${Math.abs(x) >= 100 || !s ? whole.format(x) : one.format(x)}${s}`;
}

/** A value in its unit; `short` for ticks and tight places (compact everywhere). */
export function formatValue(v: number, unit: StatUnit, short = false): string {
  switch (unit) {
    case "ms":
      return formatDuration(v, short);
    case "bytes":
      return formatBytes(v);
    case "percent":
      return `${v < 10 && v > 0 && !short ? one.format(v) : whole.format(v)}%`;
    default:
      return Math.abs(v) >= 10_000 || (short && Math.abs(v) >= 1000) ? formatCompact(v) : v % 1 ? one.format(v) : whole.format(v);
  }
}

/** The change from `prev` to `cur`: "+18%", "−4%", "new" (from nothing), "" (nothing either time); percentages change by points. */
export function formatDelta(cur: number, prev: number, unit?: StatUnit): string {
  if (unit === "percent") {
    if (!cur && !prev) return "";
    const d = cur - prev;
    return Math.abs(d) < 0.05 ? "±0" : `${d > 0 ? "+" : "−"}${one.format(Math.abs(d))} pt`;
  }
  if (!prev) return cur ? "new" : "";
  const p = ((cur - prev) / prev) * 100;
  if (Math.abs(p) < 0.5) return "±0%";
  return `${p > 0 ? "+" : "−"}${Math.abs(p) >= 10 ? whole.format(Math.abs(p)) : one.format(Math.abs(p))}%`;
}

/** "0.4 s", "4 s", "7 min", "1 h 5 min" (the copywriting skill's durations): the app's words for how long something took. */
export function durationText(ms: number): string {
  if (ms > 0 && ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Stable per-project hue (FNV-1a, as in the ghostty-agents fork): a project's colour (0–360) in every window. */
export function projectHue(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 360;
}

/** Which way a delta went: up, down or flat. */
export const trendOf = (cur: number, prev: number): "up" | "down" | "flat" => (Math.abs(cur - prev) <= Math.abs(prev) * 0.005 ? "flat" : cur > prev ? "up" : "down");

/** ▁▂▃▄▅▆▇█ for a series; null values as a space. */
export function sparkline(values: (number | null)[]): string {
  const xs = values.filter((v): v is number => v !== null);
  const max = Math.max(0, ...xs);
  const bars = "▁▂▃▄▅▆▇█";
  return values.map((v) => (v === null ? " " : max ? bars[Math.min(7, Math.round((v / max) * 7))] : bars[0])).join("");
}

/** A bar `width` cells wide at `share` (0…1), in eighth blocks. */
export function blockBar(share: number, width: number): string {
  const eighths = Math.round(Math.max(0, Math.min(1, share)) * width * 8);
  const part = " ▏▎▍▌▋▊▉"[eighths % 8]!;
  return "█".repeat(Math.floor(eighths / 8)) + (eighths % 8 ? part : "");
}

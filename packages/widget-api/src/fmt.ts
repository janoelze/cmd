// `fmt`: numbers, times and sizes as cmd writes them everywhere ("3h 12m", "1.2K",
// "12 s ago"), so a widget's text reads like a built-in's. Pure functions, no locale
// surprises: the same output on the Mac, in the phone client and in tests. 1.3's `value`,
// `delta`, `hue` and coarse `dur` are cmd's own formatters (protocol format.ts), the very
// functions the Stats window and the native views call, so a port prints what they print,
// in the app's locale (`env.locale`: "1,5" where the app writes "1,5").

import { durationText, formatDelta, formatValue, projectHue } from "@cmd/protocol/format";
import type { Unit } from "./elements.gen.ts";
import { runningLocale } from "./connection.ts";

type When = Date | string | number;

const ms = (t: When) => (t instanceof Date ? t.getTime() : typeof t === "string" ? Date.parse(t) : t);
const one = (n: number) => (Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * How long ago `t` was, compact: "now", "12s", "4m", "3h", "2d". Pass `now` (from
 * `useNow`) so the text re-renders as time passes.
 * @since 1.0
 */
export function ago(t: When, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms(t)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/**
 * A duration in seconds as "3h 12m", "48m", "12s"; with `{ coarse: true }` (1.3) in words as
 * the app's lists say how long something took: "0.4 s", "4 s", "7 min", "1 h 5 min".
 * @since 1.0
 */
export function dur(seconds: number | null | undefined, opts?: { coarse?: boolean }): string {
  if (opts?.coarse) return durationText(seconds != null && Number.isFinite(seconds) ? seconds * 1000 : 0);
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "0s";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * A count, compact past a thousand: "950", "1.2K", "3.4M", "2.1B"; "–" for nothing.
 * @since 1.0
 */
export function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a < 1000) return Number.isInteger(n) ? String(n) : one(n);
  const [d, s] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  return `${one(n / d)}${s}`;
}

/**
 * Bytes in binary steps: "512 B", "1.5 KB", "3.2 GB".
 * @since 1.0
 */
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
  return `${i ? one(n) : Math.round(n)} ${units[i]}`;
}

/**
 * A percentage of 0–100: "42%", "3.5%".
 * @since 1.0
 */
export function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return `${one(n)}%`;
}

/**
 * A clock time, "14:05".
 * @since 1.0
 */
export function time(t: When): string {
  const d = new Date(ms(t));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A date, "2026-10-14".
 * @since 1.0
 */
export function date(t: When): string {
  const d = new Date(ms(t));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A value in a chart's unit, as the charts and the Stats window write it: "3h 12m" (ms), "1.2K",
 * "4.5 MB", "42%"; `short` for tight places ("3h", "1.2K").
 * @since 1.3
 */
export function value(v: number, unit: Unit = "count", opts?: { short?: boolean }): string {
  return formatValue(v, unit, opts?.short === true, runningLocale());
}

/**
 * The change from `prev` to `cur` as the Stats window writes it: "+18%", "−4%", "new" (from
 * nothing), "" (nothing either time); percentages change by points ("+2.5 pt"). A Stat's or a
 * chart's `delta`, with its `trend` (`cur` against `prev`).
 * @since 1.3
 */
export function delta(cur: number, prev: number, unit?: Unit): string {
  return formatDelta(cur, prev, unit, runningLocale());
}

/**
 * A name's hue (0–360) as cmd colours projects: the same hue for the same name in every window
 * (a Chip's or a TimelineEntry's `hue`).
 * @since 1.3
 */
export function hue(name: string): number {
  return projectHue(name);
}

/** Formatting helpers: `fmt.ago`, `fmt.dur`, `fmt.num`, `fmt.bytes`, `fmt.pct`, `fmt.time`, `fmt.date`, and 1.3's `fmt.value`, `fmt.delta`, `fmt.hue`. @since 1.0 */
export const fmt = { ago, dur, num, bytes, pct, time, date, value, delta, hue };

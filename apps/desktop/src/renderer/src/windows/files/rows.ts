// The file browser's rows: their order, their dates, and how many are drawn at a
// time (a folder of thousands is drawn a part a frame, not in one long frame).

import { useEffect, useState } from "react";
import type { FileEntry } from "@cmd/protocol";
import type { TreeSort } from "@cmd/ui";

// Formatters are built once: toLocale*String with options builds one per call,
// which costs more than the rest of rendering a row.
const TIME = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat([], { day: "numeric", month: "short", year: "numeric" });
// Likewise a collator: localeCompare with options builds one per comparison.
const NAMES = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Today, as [start, end) in ms: rows compare against it rather than each making two Dates. */
let today: [number, number] = [0, 0];
export function when(ms: number): string {
  if (!ms) return "";
  const now = Date.now();
  if (now >= today[1] || now < today[0]) {
    const start = new Date(now).setHours(0, 0, 0, 0);
    today = [start, new Date(start).setDate(new Date(start).getDate() + 1)];
  }
  return ms >= today[0] && ms < today[1] ? TIME.format(ms) : DATE.format(ms);
}

/** Rows drawn in one go; a list longer than this grows by as many each frame. */
const DRAW_STEP = 300;

/** How many of `total` rows to draw: DRAW_STEP at first, then DRAW_STEP more a frame until all are. */
export function useDrawnRows(total: number): number {
  const [drawn, setDrawn] = useState(DRAW_STEP);
  useEffect(() => {
    // Shrunk (a folder closed): the next long one grows from the start again.
    if (drawn > Math.max(DRAW_STEP, total)) return setDrawn(Math.max(DRAW_STEP, total));
    if (drawn >= total) return;
    const id = requestAnimationFrame(() => setDrawn((n) => n + DRAW_STEP));
    return () => cancelAnimationFrame(id);
  }, [drawn, total]);
  return drawn;
}

const byName = (a: FileEntry, b: FileEntry) => NAMES.compare(a.name, b.name);

/** A folder's entries in the chosen order, folders first; ties go by name. */
export function sorted(list: readonly FileEntry[], s: TreeSort): FileEntry[] {
  const dir = s.desc ? -1 : 1;
  const by = s.key === "size" ? (a: FileEntry, b: FileEntry) => a.size - b.size : s.key === "date" ? (a: FileEntry, b: FileEntry) => a.mtime - b.mtime : byName;
  return [...list].sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || dir * by(a, b) || byName(a, b));
}

// Event Stream, a developer widget (docs/16-widgets.md, docs/28): every event
// cmd records, newest first, as it's recorded, through one live query over the
// whole log. It knows no event types or fields: rows are drawn from whatever an
// event carries, classes come from the core (data.explain), and the filter
// searches the whole event, so new types, fields and classes show up as they
// are. An event recorded again (a command that ended, output that grew)
// replaces its row and moves it up. A click shows the event as stored; the
// title bar's menu hides classes, pauses and clears.

import { Chip, CodeBlock, EmptyState, ListRow, ListValue, Panel, PanelBody, ToolbarSearchField, WindowToolbar } from "@cmd/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DataClassInfo, DataEvent } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { projectHue } from "../model.ts";
import { subscribeData } from "../store.ts";
import { goTo, useWidgetStatus } from "../widgets.ts";
import type { WindowViewProps } from "../windows/registry.ts";

/** Events kept in the list. */
const KEEP = 1000;
/** Rows drawn (the newest of what matches). */
const SHOW = 300;
/** Fields the row shows in its own places (title, time) or only when opened, not in the detail line. */
const OWN = new Set(["id", "seq", "at", "until", "text", "data"]);

export type EventClass = Pick<DataClassInfo, "class" | "title" | "types">;

// The core's classes, asked for once and shared with the title bar's menu (windows/builtin.tsx).
let classes: EventClass[] = [];
const classListeners = new Set<() => void>();
let asked = false;
export function eventClasses(): EventClass[] {
  if (!asked) {
    asked = true;
    void cmd.call("data.explain", {}).then(
      (cs) => {
        classes = cs.map(({ class: c, title, types }) => ({ class: c, title, types }));
        for (const fn of classListeners) fn();
      },
      () => (asked = false),
    );
  }
  return classes;
}
function useEventClasses(): EventClass[] {
  const [, redraw] = useState(0);
  useEffect(() => {
    const fn = () => redraw((n) => n + 1);
    classListeners.add(fn);
    return () => void classListeners.delete(fn);
  }, []);
  return eventClasses();
}

/** An event's class by the core's rules (its exact type, then a prefix); else the first part of its type. */
export function classOfEvent(type: string, cs: EventClass[]): string {
  return cs.find((c) => c.types.includes(type))?.class ?? cs.find((c) => c.types.some((t) => t.endsWith(".") && type.startsWith(t)))?.class ?? type.split(".")[0]!;
}

interface Row {
  e: DataEvent;
  /** Times it was recorded again since it showed up. */
  updates: number;
  /** The whole event as lowercase text, for the filter. */
  hay: string;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const clip = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A span's length ("1.5 s", "4 min"). */
const lasted = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/** The envelope's other fields that have a value, as "name value", in the order the event has them; a span says how long it lasted. */
export function details(e: DataEvent): string[] {
  const fields = Object.entries(e)
    .filter(([k, v]) => !OWN.has(k) && v !== null && v !== undefined && v !== "" && typeof v !== "object")
    .map(([k, v]) => (k === "type" || k === "source" ? String(v) : `${k} ${clip(String(v))}`));
  return typeof e.until === "number" && e.until > e.at ? [...fields, `lasted ${lasted(e.until - e.at)}`] : fields;
}

/** Newest first; a row recorded again moves up. */
function merge(rows: Row[], events: DataEvent[]): Row[] {
  const byId = new Map(rows.map((r) => [r.e.id, r]));
  const fresh: Row[] = [];
  for (const e of events) {
    const had = byId.get(e.id);
    byId.delete(e.id);
    const i = fresh.findIndex((r) => r.e.id === e.id);
    if (i >= 0) fresh.splice(i, 1);
    fresh.unshift({ e, updates: had ? had.updates + 1 : 0, hay: JSON.stringify(e).toLowerCase() });
  }
  return [...fresh, ...rows.filter((r) => byId.has(r.e.id))].slice(0, KEEP);
}

function useEventStream(paused: boolean): { rows: Row[]; waiting: number; arrivals: number[]; clear: () => void } {
  const [rows, setRows] = useState<Row[]>([]);
  /** When each event came, for the rate (rows are capped, arrivals aren't). */
  const arrivals = useRef<number[]>([]);
  const held = useRef<DataEvent[]>([]);
  const [waiting, setWaiting] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(
    () =>
      subscribeData({ by: "time", order: "desc", limit: 200 }, (events, initial) => {
        if (initial) return setRows(merge([], [...events].reverse()));
        const now = Date.now();
        for (let i = 0; i < events.length; i++) arrivals.current.push(now);
        while (arrivals.current.length && now - arrivals.current[0]! > 60_000) arrivals.current.shift();
        if (pausedRef.current) {
          held.current.push(...events);
          return setWaiting(held.current.length);
        }
        setRows((rs) => merge(rs, events));
      }),
    [],
  );
  useEffect(() => {
    if (paused || !held.current.length) return;
    const events = held.current;
    held.current = [];
    setWaiting(0);
    setRows((rs) => merge(rs, events));
  }, [paused]);
  return { rows, waiting, arrivals: arrivals.current, clear: () => ((held.current = []), setWaiting(0), setRows([])) };
}

/** Clear lives in the title bar's menu (windows/builtin.tsx); it reaches the view through this. */
const clearers = new Map<string, () => void>();
export const clearEventStream = (windowId: string) => clearers.get(windowId)?.();

export function EventsView({ win }: WindowViewProps) {
  const paused = win.state.paused === true;
  const hidden = useMemo(() => new Set(Array.isArray(win.state.hidden) ? (win.state.hidden as string[]) : []), [win.state.hidden]);
  const cs = useEventClasses();
  const { rows, waiting, arrivals, clear } = useEventStream(paused);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    clearers.set(win.id, clear);
    return () => void clearers.delete(win.id);
  });
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => rows.filter((r) => !hidden.has(classOfEvent(r.e.type, cs)) && (!q || r.hay.includes(q))).slice(0, SHOW), [rows, hidden, q, cs]);
  const perMinute = arrivals.filter((t) => now - t < 60_000).length;
  useWidgetStatus(win.id, paused ? (waiting ? `Paused · ${waiting} waiting` : "Paused") : perMinute ? `${perMinute}/min` : null);

  const rowMenu = (e: DataEvent) =>
    void showContextMenu([
      { label: "Copy Event", run: () => copy(JSON.stringify(e, null, 2)) },
      { label: "Copy ID", run: () => copy(e.id) },
      "-",
      { label: `Only ${e.type}`, run: () => setQuery(e.type) },
      ...(e.paneId ? [{ label: "Show Terminal", run: () => goTo(e.paneId!, e.workspaceId ?? undefined) }] : []),
    ]);

  const row = ({ e, updates }: Row) => {
    const cls = classOfEvent(e.type, cs);
    return [
      <ListRow
        key={e.id}
        title={e.text || e.type}
        detail={[...details(e), updates ? `recorded again ×${updates}` : null].filter(Boolean).join(" · ")}
        tip={e.id}
        selected={open === e.id}
        end={
          <>
            <Chip hue={projectHue(cls)}>{cs.find((c) => c.class === cls)?.title ?? cls}</Chip>
            <ListValue>{clock(e.at)}</ListValue>
          </>
        }
        onClick={() => setOpen(open === e.id ? null : e.id)}
        onContextMenu={() => rowMenu(e)}
      />,
      open === e.id && (
        <CodeBlock key={`${e.id}:json`} maxHeight={320}>
          {JSON.stringify(e, null, 2)}
        </CodeBlock>
      ),
    ];
  };

  return (
    <Panel>
      <WindowToolbar label="Filter events">
        <ToolbarSearchField value={query} placeholder="Filter: any word in an event" count={q ? `${shown.length}` : undefined} onChange={setQuery} />
      </WindowToolbar>
      <PanelBody>
        {shown.map(row)}
        {shown.length === 0 && (
          <EmptyState compact icon="waveform.path.ecg" title={rows.length ? "Nothing matches" : "Nothing recorded yet"}>
            {rows.length ? "Change the filter, or show the classes you hid." : "Events show up here as cmd records them."}
          </EmptyState>
        )}
      </PanelBody>
    </Panel>
  );
}

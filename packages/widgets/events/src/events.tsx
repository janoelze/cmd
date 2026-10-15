// Event Log, a built-in widget package (docs/57; the native Event Stream's job): every event cmd
// records in this workspace (or every workspace's), newest first, as it is recorded, from one
// live query (useEvents). It knows no event types or fields: a row is the log's one line for the
// event (API 1.2's `text`, else its type) and whatever plain values its data carries; the
// toolbar's Show menu hides the log's classes as Settings names them (cmd.events.classes, 1.2;
// on an older cmd, the families of the types it has seen), and the filter searches the whole
// event. An event recorded again (a command that ended) replaces its row and moves up. A click
// opens the event as stored; a row's menu copies it or its ID; the title menu switches the
// scope, pauses and clears.

import {
  Window,
  View,
  WindowToolbar,
  ToolbarSearchField,
  ToolbarMenu,
  List,
  ListRow,
  ListRowContent,
  ListRowEnd,
  ListValue,
  Chip,
  CodeBlock,
  useEvents,
  useStoredState,
  useNow,
  cmd,
  type Event,
  type EventClass,
} from "@cmd/widget-api";
import { useEffect, useState } from "react";

type Scope = "workspace" | "all";

/** Events kept from the log, and rows drawn (the newest of what matches). */
export const KEEP = 500;
export const SHOW = 300;

/** An event's kind: the first part of its type ("agent" for "agent.stop"). */
export const familyOf = (type: string) => type.split(".")[0] || type;

/** The class of an event type, as cmd decides it: a class naming the type wins over one naming its prefix; "system" when none does. */
export function classOf(type: string, classes: readonly EventClass[]): string {
  for (const c of classes) if (c.types.includes(type)) return c.class;
  for (const c of classes) for (const t of c.types) if (t.endsWith(".") && type.startsWith(t)) return c.class;
  return "system";
}

/** The log's classes as Settings names them, read once; none on a cmd before 1.2 (the families of types instead). */
function useClasses(): EventClass[] {
  const [classes, setClasses] = useState<EventClass[]>([]);
  useEffect(() => {
    if (cmd.env.has("events.classes")) void cmd.events.classes().then(setClasses, () => {});
  }, []);
  return classes;
}

/** A stable hue per kind, so a kind's chip keeps its colour. */
export function hueOf(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const clip = (s: string, n = 32) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A span's length ("1.5 s", "4 min"). */
const lasted = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/** The plain values an event's data carries, as "name value", in its order; a span says how long it lasted. */
export function details(e: Event): string[] {
  const fields = Object.entries(e.data)
    .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k} ${clip(String(v))}`);
  return typeof e.until === "number" && e.until > e.at ? [...fields, `lasted ${lasted(e.until - e.at)}`] : fields;
}

/** Newest first: the log's order is arrival (useEvents appends, a recorded-again event at the end), so a row recorded again moves up. */
export function newestFirst(events: readonly Event[]): Event[] {
  const seen = new Set<string>();
  const out: Event[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const k = e.key ?? `#${e.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export default function EventLog() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  // Classes since 1.2 (kept apart from 1.0's families, which named other things).
  const classes = useClasses();
  const [hidden, setHidden] = useStoredState<string[]>(classes.length ? "hiddenClasses" : "hidden", []);
  const [pausedAt, setPausedAt] = useStoredState<number | null>("pausedAt", null);
  const [clearedAt, setClearedAt] = useStoredState<number>("clearedAt", 0);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow(5000);
  const live = newestFirst(useEvents({ limit: KEEP, ...(scope === "all" ? { scope } : {}) })).filter((e) => e.at > clearedAt);

  // Paused: the rows stay as they were when it paused (across a reload too); what came since waits, counted.
  const paused = pausedAt !== null;
  const all = paused ? live.filter((e) => e.at <= pausedAt) : live;
  const waiting = live.length - all.length;

  /** What an event is grouped by: its class, else (an older cmd) its family. */
  const groupOf = (e: Event) => (classes.length ? classOf(e.type, classes) : familyOf(e.type));
  const titleOf = (g: string) => classes.find((c) => c.class === g)?.title ?? g;
  const families = [...new Set([...all.map(groupOf), ...hidden])].sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  const q = query.trim().toLowerCase();
  const shown = all.filter((e) => !hidden.includes(groupOf(e)) && (!q || JSON.stringify(e).toLowerCase().includes(q))).slice(0, SHOW);
  const perMinute = live.filter((e) => now - e.at < 60_000).length;
  const status = paused ? (waiting ? `Paused · ${waiting} waiting` : "Paused") : perMinute ? `${perMinute}/min` : null;

  const toggle = (f: string) => setHidden(hidden.includes(f) ? hidden.filter((x) => x !== f) : [...hidden, f]);
  const key = (e: Event) => e.key ?? `#${e.id}`;

  const state = all.length === 0
    ? { icon: "waveform.path.ecg", title: "Nothing recorded yet", text: scope === "all" ? "Events show up here as cmd records them." : "Events in this workspace show up here as cmd records them." }
    : shown.length === 0
      ? { kind: "noResults" as const, title: "Nothing matches", text: q ? `No event mentions “${query.trim()}”.` : "Every kind here is hidden.", action: q ? { label: "Clear Filter", run: () => setQuery("") } : { label: "Show All", run: () => setHidden([]) } }
      : null;

  return (
    <Window
      status={status}
      menu={[
        { label: "This Workspace", checked: scope === "workspace", run: () => setScope("workspace") },
        { label: "All Workspaces", checked: scope === "all", run: () => setScope("all") },
        { separator: true },
        { label: paused ? "Resume" : "Pause", run: () => setPausedAt(paused ? null : Date.now()) },
        { label: "Clear", run: () => (setClearedAt(Date.now()), setOpen(null)) },
      ]}
    >
      <View state={state}>
        <WindowToolbar label="Filter events">
          <ToolbarSearchField value={query} placeholder="Filter: any word in an event" count={q ? `${shown.length}` : undefined} onChange={setQuery} />
          <ToolbarMenu
            label={hidden.length ? `${hidden.length} hidden` : "Show"}
            icon="line.3.horizontal.decrease"
            menu={[
              ...families.map((f) => ({ label: titleOf(f), checked: !hidden.includes(f), run: () => toggle(f) })),
              { separator: true as const },
              { label: "Show All", disabled: hidden.length === 0, run: () => setHidden([]) },
            ]}
          />
        </WindowToolbar>
        <List>
          {shown.flatMap((e) => {
            const fam = groupOf(e);
            const text = e.text?.trim() || null;
            const row = (
              <ListRow
                key={key(e)}
                selected={open === key(e)}
                tip={e.key}
                onClick={() => setOpen(open === key(e) ? null : key(e))}
                menu={[
                  { label: `Only ${e.type}`, run: () => setQuery(e.type) },
                  { label: `Hide ${titleOf(fam)}`, run: () => toggle(fam) },
                  { label: "Show Terminal", disabled: !e.terminalId, run: () => e.terminalId && void cmd.windows.select(e.terminalId).catch(() => {}) },
                  { separator: true },
                  { label: "Copy Event", run: () => void cmd.clipboard.write(JSON.stringify(e, null, 2)).catch(() => {}) },
                  { label: "Copy ID", disabled: !e.key, run: () => e.key && void cmd.clipboard.write(e.key).catch(() => {}) },
                ]}
              >
                <ListRowContent title={text ?? e.type} detail={[text ? e.type : null, ...details(e)].filter(Boolean).join(" · ") || null} />
                <ListRowEnd>
                  <Chip hue={hueOf(fam)}>{fam}</Chip>
                  <ListValue>{clock(e.at)}</ListValue>
                </ListRowEnd>
              </ListRow>
            );
            return open === key(e)
              ? [row, <CodeBlock key={`${key(e)}:json`} maxHeight={320}>{JSON.stringify(e, null, 2)}</CodeBlock>]
              : [row];
          })}
        </List>
      </View>
    </Window>
  );
}

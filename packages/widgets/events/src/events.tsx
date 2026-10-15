// Event Log, a built-in widget package (docs/57; the native Event Stream's job, drawn as it is):
// every event cmd records in this workspace (or every workspace's), newest first, as it is
// recorded, from one live subscription (useEvents). It knows no event types or fields: a row is
// the log's one line for the event (else its type), its type and whatever plain values its data
// carries; the filter searches the whole event. An event recorded again (a command that ended)
// replaces its row, moves up and says how often since it showed up ("recorded again ×2": the
// event's `again`). The list runs to the window's edges under the filter (a Panel). A row's chip
// names its class as Settings does, in the hue cmd gives that name (fmt.hue). A click opens the
// event as stored; a row's menu copies it or its ID. The title menu, whose button says
// "All Events" or "3 hidden", switches the scope, pauses, clears and hides the log's classes;
// the hidden classes are one preference for every Event Log (the package's storage), the rest
// is the window's own.

import {
  Window,
  Panel,
  PanelBody,
  WindowToolbar,
  ToolbarSearchField,
  EmptyState,
  ListRow,
  ListRowContent,
  ListRowEnd,
  ListValue,
  Chip,
  CodeBlock,
  useEnv,
  useEvents,
  useStorage,
  useStoredState,
  useNow,
  fmt,
  cmd,
  type Event,
  type LiveEvent,
  type EventClass,
  type MenuEntry,
} from "@cmd/widget-api";
import { useEffect, useState } from "react";

type Scope = "workspace" | "all";

/** Events kept from the log, and rows drawn (the newest of what matches). */
export const KEEP = 500;
export const SHOW = 300;

/** The class of an event type, as cmd decides it: a class naming the type wins over one naming its prefix; "system" when none does. */
export function classOf(type: string, classes: readonly EventClass[]): string {
  for (const c of classes) if (c.types.includes(type)) return c.class;
  for (const c of classes) for (const t of c.types) if (t.endsWith(".") && type.startsWith(t)) return c.class;
  return "system";
}

/** The log's classes as Settings names them, in cmd's order, read once. */
function useClasses(): EventClass[] {
  const [classes, setClasses] = useState<EventClass[]>([]);
  useEffect(() => void cmd.events.classes().then(setClasses, () => {}), []);
  return classes;
}

const clip = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A span's length ("1.5 s", "4 min"). */
const lasted = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/** The event's type, then the plain values its data carries as "name value", in its order; a span says how long it lasted. */
export function details(e: Event): string[] {
  const fields = Object.entries(e.data)
    .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k} ${clip(String(v))}`);
  return [e.type, ...fields, ...(typeof e.until === "number" && e.until > e.at ? [`lasted ${lasted(e.until - e.at)}`] : [])];
}

const keyOf = (e: Event) => e.key ?? `#${e.id}`;

export default function EventLog() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  const [hidden, setHidden] = useStorage<string[]>("package", "hiddenClasses", []);
  const [pausedAt, setPausedAt] = useStoredState<number | null>("pausedAt", null);
  const [clearedAt, setClearedAt] = useStoredState<number>("clearedAt", 0);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const classes = useClasses();
  const { locale } = useEnv();
  const now = useNow(5000);
  // Newest first; the log's order is arrival, so a row recorded again moves up.
  const live = useEvents({ limit: KEEP, ...(scope === "all" ? { scope } : {}) }).filter((e) => e.at > clearedAt).reverse();

  // Paused: the rows stay as they were when it paused (across a reload too); what came since waits, counted.
  const paused = pausedAt !== null;
  const all = paused ? live.filter((e) => e.at <= pausedAt) : live;
  const waiting = live.length - all.length;

  const titleOf = (cls: string) => classes.find((c) => c.class === cls)?.title ?? cls;
  const q = query.trim().toLowerCase();
  const shown = all.filter((e) => !hidden.includes(classOf(e.type, classes)) && (!q || JSON.stringify(e).toLowerCase().includes(q))).slice(0, SHOW);
  const perMinute = live.filter((e) => now - e.at < 60_000).length;
  const status = paused ? (waiting ? `Paused · ${waiting} waiting` : "Paused") : perMinute ? `${perMinute}/min` : null;
  const clock = (t: number) => new Date(t).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  // The title menu and the window's context menu, as the native window's.
  const menu: MenuEntry[] = [
    { label: "This Workspace", checked: scope === "workspace", run: () => setScope("workspace") },
    { label: "All Workspaces", checked: scope === "all", run: () => setScope("all") },
    { separator: true },
    { label: paused ? "Resume" : "Pause", run: () => setPausedAt(paused ? null : Date.now()) },
    { label: "Clear", run: () => (setClearedAt(Date.now()), setOpen(null)) },
    { separator: true },
    ...classes.map((c) => ({ label: c.title, checked: !hidden.includes(c.class), run: () => setHidden(hidden.includes(c.class) ? hidden.filter((x) => x !== c.class) : [...hidden, c.class]) })),
    { label: "Show All", disabled: hidden.length === 0, run: () => setHidden([]) },
  ];

  const rowMenu = (e: LiveEvent): MenuEntry[] => [
    { label: "Copy Event", run: () => void cmd.clipboard.write(JSON.stringify(e, null, 2)).catch(() => {}) },
    { label: "Copy ID", run: () => void cmd.clipboard.write(keyOf(e)).catch(() => {}) },
    { separator: true },
    { label: `Only ${e.type}`, run: () => setQuery(e.type) },
    ...(e.terminalId ? [{ label: "Show Terminal", run: () => void cmd.windows.select(e.terminalId!).catch(() => {}) }] : []),
  ];

  return (
    <Window status={status} menu={menu} menuLabel={hidden.length ? `${hidden.length} hidden` : "All Events"} actions={menu}>
      <Panel>
        <WindowToolbar label="Filter events">
          <ToolbarSearchField value={query} placeholder="Filter: any word in an event" count={q ? `${shown.length}` : undefined} onChange={setQuery} />
        </WindowToolbar>
        <PanelBody>
          {shown.flatMap((e) => {
            const cls = classOf(e.type, classes);
            const key = keyOf(e);
            const row = (
              <ListRow key={key} selected={open === key} tip={key} onClick={() => setOpen(open === key ? null : key)} menu={rowMenu(e)}>
                <ListRowContent title={e.text?.trim() || e.type} detail={[...details(e), e.again ? `recorded again ×${e.again}` : null].filter(Boolean).join(" · ")} />
                <ListRowEnd>
                  <Chip hue={fmt.hue(cls)}>{titleOf(cls)}</Chip>
                  <ListValue>{clock(e.at)}</ListValue>
                </ListRowEnd>
              </ListRow>
            );
            return open === key ? [row, <CodeBlock key={`${key}:json`} maxHeight={320}>{JSON.stringify(e, null, 2)}</CodeBlock>] : [row];
          })}
          {shown.length === 0 && (
            <EmptyState
              compact
              icon="waveform.path.ecg"
              title={all.length ? "Nothing matches" : "Nothing recorded yet"}
              text={all.length ? "Change the filter, or show the classes you hid." : scope === "all" ? "Events show up here as cmd records them." : "Events in this workspace show up here as cmd records them."}
            />
          )}
        </PanelBody>
      </Panel>
    </Window>
  );
}

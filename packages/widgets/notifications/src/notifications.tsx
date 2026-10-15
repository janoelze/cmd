// Notification Log, a built-in widget package (docs/57; the native Notifications' job, drawn as
// it is): the notifications cmd sent in this workspace (or every workspace's), shown or not, so
// one missed while away is still here. One live query over the log's notification events
// (useEvents; notes need no class), newest first, under Today and Earlier, in a list that runs
// to the window's edges (a Panel). A click goes to the terminal or window a notification is
// about (the event's terminalId or windowId) while it is open; its menu says which, and copies
// its text. Clear Notifications keeps when it cleared in the package's storage, so it clears
// every Notification Log at once, in every workspace, as the native Clear does. A refusal (All
// Workspaces without the grant) says what it needs.

import { Window, View, Panel, PanelBody, EmptyState, List, ListSection, ListRow, ListRowIcon, ListRowContent, ListRowEnd, ListValue, useEnv, useEvents, useStorage, useStoredState, useTerminals, useWindows, useNow, fmt, cmd, ApiCallError, type Event } from "@cmd/widget-api";
import { Component, type ReactNode } from "react";

type Scope = "workspace" | "all";

/** Notifications kept from the log. */
export const KEEP = 200;

/** A notification as the log keeps it. */
export interface Note {
  key: string;
  source: string;
  title: string;
  body: string;
  urgent: boolean;
  at: number;
  terminalId: string | null;
  /** The window it is about (a widget's, a timer's), when it isn't about a terminal. */
  windowId: string | null;
}

/** Each source's icon (the native view's). */
const ICONS: Record<string, string> = {
  "agent-input": "person.crop.circle.badge.questionmark",
  "agent-done": "person.crop.circle.badge.checkmark",
  bell: "bell",
  terminal: "terminal",
  command: "terminal",
  cli: "bell",
  widget: "sparkles",
  summary: "doc.text",
  timer: "timer",
};
export const iconOf = (source: string) => ICONS[source] ?? "bell";

export function noteOf(e: Event): Note {
  const d = e.data as { source?: string; title?: string; body?: string; urgent?: boolean };
  return { key: e.key ?? `#${e.id}`, source: String(d.source ?? ""), title: String(d.title ?? "") || "Notification", body: String(d.body ?? ""), urgent: !!d.urgent, at: e.at, terminalId: e.terminalId ?? null, windowId: e.windowId ?? null };
}

/** Newest first, one row per notification (one recorded again replaces the earlier). */
export function newestFirst(events: readonly Event[]): Note[] {
  const seen = new Set<string>();
  const out: Note[] = [];
  for (const n of events.map(noteOf).sort((a, b) => b.at - a.at)) {
    if (seen.has(n.key)) continue;
    seen.add(n.key);
    out.push(n);
  }
  return out;
}

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

function Notifications() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  const [clearedAt, setClearedAt] = useStorage("package", "clearedAt", 0);
  const { locale } = useEnv();
  const now = useNow(30_000);
  const where = scope === "all" ? { scope } : {};
  const notes = newestFirst(useEvents({ types: ["notification"], limit: KEEP, ...where })).filter((n) => n.at > clearedAt);
  // What is still open to go to: the terminals and windows in scope.
  const open = new Set([...useTerminals(where).map((t) => t.id), ...useWindows(where).map((w) => w.id)]);
  const today = startOfDay(now);
  const groups = [
    { title: "Today", items: notes.filter((n) => n.at >= today) },
    { title: "Earlier", items: notes.filter((n) => n.at < today) },
  ].filter((g) => g.items.length > 0);

  /** The terminal or window it is about, while it is open. */
  const target = (n: Note) => [n.terminalId, n.windowId].find((id) => id && open.has(id)) ?? null;
  const go = (n: Note) => {
    const id = target(n);
    if (id) void cmd.windows.select(id).catch(() => {});
  };

  return (
    <Window
      status={null}
      menu={[
        { label: "This Workspace", checked: scope === "workspace", run: () => setScope("workspace") },
        { label: "All Workspaces", checked: scope === "all", run: () => setScope("all") },
        { separator: true },
        { label: "Clear Notifications", disabled: notes.length === 0, run: () => setClearedAt(Date.now()) },
      ]}
    >
      <Panel>
        <PanelBody>
          <List>
            {groups.map((g) => (
              <ListSection key={g.title} title={g.title} count={g.items.length}>
                {g.items.map((n) => (
                  <ListRow
                    key={n.key}
                    tip={n.body.length > 60 ? n.body : undefined}
                    onClick={() => go(n)}
                    menu={[
                      { label: n.terminalId ? "Show Terminal" : "Show Window", disabled: !target(n), run: () => go(n) },
                      { label: "Copy Text", run: () => void cmd.clipboard.write(n.body ? `${n.title}\n${n.body}` : n.title).catch(() => {}) },
                    ]}
                  >
                    <ListRowIcon icon={iconOf(n.source)} />
                    <ListRowContent title={n.title} detail={n.body || " "} tone={n.urgent && n.source !== "timer" ? "needs" : undefined} />
                    <ListRowEnd>
                      <ListValue>{n.at >= today ? new Date(n.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : fmt.ago(n.at, now)}</ListValue>
                    </ListRowEnd>
                  </ListRow>
                ))}
              </ListSection>
            ))}
          </List>
          {notes.length === 0 && (
            <EmptyState compact icon="bell" title="No notifications" text="When an agent needs you or a long command finishes, it shows up here, even if you missed it." />
          )}
        </PanelBody>
      </Panel>
    </Window>
  );
}

/** A refused read (All Workspaces without `workspace: ["all"]`) as a state with the way back, not the error callout. */
class Refusal extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Anything else goes on to the runtime's own boundary, which reports it.
    if (!(error instanceof ApiCallError && error.code === "permission")) throw error;
    return <RefusedView error={error} onBack={() => this.setState({ error: null })} />;
  }
}

function RefusedView({ error, onBack }: { error: ApiCallError; onBack: () => void }) {
  const [, setScope] = useStoredState<Scope>("scope", "workspace");
  return (
    <Window status={null}>
      <View state={{ kind: "error", title: "Notifications aren't shared with this widget", text: error.message, action: { label: "Show This Workspace", run: () => (setScope("workspace"), onBack()) } }} />
    </Window>
  );
}

export default function NotificationLog() {
  return (
    <Refusal>
      <Notifications />
    </Refusal>
  );
}

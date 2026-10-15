// Fixture data for widget tests (`fixtures.agent({ name: "Tours", state: "waiting" })`):
// whole API objects from a few fields, with ids derived from the name (agent "Tours" is
// a-tours in window w-tours, terminal t-tours) so a test can name what it expects.

import { agentIcon, agentLight, type ApiAppUsage, type ApiJournalWeek, type ApiAgent, type ApiAgentState, type ApiEvent, type ApiEventClass, type ApiJournalDay, type ApiJournalEntry, type ApiNowPlaying, type ApiStatQuery, type ApiStatResult, type ApiTerminal, type ApiTerminalUsage, type ApiWindow, type ApiWorkspace } from "@cmd/protocol/widget-tree";

/** The workspace fixtures live in unless told otherwise. */
export const WORKSPACE_ID = "ws-1";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

/** Where an agent in each state sorts, as the core has it when the person hasn't looked yet. Its light and icon are the protocol's, as the core's are. */
const BUCKET: Record<ApiAgentState, ApiAgent["bucket"]> = { starting: "rest", working: "rest", idle: "rest", waiting: "needs", done: "unseen", exited: "rest", failed: "rest" };

/** A workspace. @since 1.0 */
export function workspace(over: Partial<ApiWorkspace> = {}): ApiWorkspace {
  return { id: WORKSPACE_ID, name: "app", root: "/Users/me/src/app", branch: "main", ...over };
}

/** An agent; its bucket and light follow its state unless given. @since 1.0 */
export function agent(over: Partial<ApiAgent> = {}): ApiAgent {
  const name = over.name ?? "Claude";
  const s = slug(name);
  const state = over.state ?? "working";
  const kind = over.kind ?? "claude";
  return {
    id: `a-${s}`,
    name,
    kind,
    state,
    stateSince: Date.now() - 60_000,
    bucket: BUCKET[state],
    light: agentLight(state, BUCKET[state]),
    icon: agentIcon(kind),
    statusLine: null,
    place: "main",
    cwd: "/Users/me/src/app",
    workspaceId: WORKSPACE_ID,
    windowId: `w-${s}`,
    terminalId: `t-${s}`,
    parentId: null,
    depth: 0,
    ...over,
  };
}

/** A terminal (a pane), with what its screen shows for `terminals.read`. @since 1.0 */
export function pane(over: Partial<ApiTerminal> & { screen?: string } = {}): ApiTerminal & { screen: string } {
  const title = over.title ?? "zsh";
  const s = slug(title);
  return { id: `t-${s}`, title, cwd: "/Users/me/src/app", workspaceId: WORKSPACE_ID, windowId: `w-${s}`, command: null, agentId: null, screen: "", ...over };
}

/** A window. @since 1.0 */
export function window(over: Partial<ApiWindow> = {}): ApiWindow {
  const title = over.title ?? "zsh";
  return { id: `w-${slug(title)}`, kind: "terminal", title, workspaceId: WORKSPACE_ID, selected: false, ...over };
}

let nextEvent = 1;

/** An event from the log (a finished command by default; `key` defaults to its id, `until` to `at`). @since 1.0 */
export function event(over: Partial<ApiEvent> = {}): ApiEvent {
  const id = nextEvent++;
  const at = over.at ?? Date.now();
  return { id, at, type: "command", workspaceId: WORKSPACE_ID, data: {}, key: `event-${id}`, until: at, terminalId: null, ...over };
}

/**
 * A command as the log keeps it: running while `exitCode` is undefined, else ended with it;
 * `ago` is how long ago it started (ms), `took` how long it ran. @since 1.1
 */
export function command(over: { command?: string; cwd?: string; exitCode?: number | null; ago?: number; took?: number; terminalId?: string | null; branch?: string; key?: string; workspaceId?: string } = {}): ApiEvent {
  const at = Date.now() - (over.ago ?? 60_000);
  const running = over.exitCode === undefined;
  return event({
    at,
    until: running ? null : at + (over.took ?? 1500),
    terminalId: over.terminalId === undefined ? "t-zsh" : over.terminalId,
    workspaceId: over.workspaceId ?? WORKSPACE_ID,
    ...(over.key ? { key: over.key } : {}),
    data: { command: over.command ?? "pnpm test", exitCode: running ? null : over.exitCode!, cwd: over.cwd ?? "/Users/me/src/app", git: over.branch ? { branch: over.branch } : null, output: null },
  });
}

/** What a terminal uses (`terminals.usage`): 1.2 MB and nothing busy unless given. @since 1.2 */
export function usage(over: Partial<ApiTerminalUsage> = {}): ApiTerminalUsage {
  const memory = over.memory ?? 1.2 * 2 ** 20;
  return { id: "t-zsh", workspaceId: WORKSPACE_ID, cpu: 0, memory, processes: 1, top: [{ name: "zsh", memory }], at: Date.now(), ...over };
}

/** A few of the log's classes as `events.classes` lists them (the real list is cmd's: Settings → Data). @since 1.2 */
export function classes(): ApiEventClass[] {
  return [
    { class: "agents", title: "Agent events", types: ["agent.", "pane.activity", "session.name"] },
    { class: "output", title: "Command output", types: ["command", "agent.output"] },
    { class: "actions", title: "Your actions", types: ["user.", "workspace."] },
    { class: "git", title: "Git", types: ["git."] },
    { class: "notes", title: "Notes and notifications", types: ["note", "notification", "notification.clear", "summary."] },
  ];
}

/**
 * A stat's answer to a query (`stats.query`): seven daily buckets ending today with `values`
 * (by default 1 to 7) as one series, or `series` as given; a count unless `unit` says. @since 1.2
 */
export function stat(q: Partial<ApiStatQuery> = {}, over: { values?: (number | null)[]; series?: { key: string; label: string; values: (number | null)[] }[]; unit?: ApiStatResult["stat"]["unit"]; title?: string } = {}): ApiStatResult {
  const day = 86_400_000;
  const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const values = over.values ?? [1, 2, 3, 4, 5, 6, 7];
  const buckets = values.map((_, i) => today - (values.length - 1 - i) * day);
  const series = (over.series ?? [{ key: "total", label: "Total", values }]).map((x) => ({ ...x, total: x.values.reduce<number>((a, b) => a + (b ?? 0), 0) }));
  const total = series.reduce((a, x) => a + x.total, 0);
  const id = q.stat || "commands.runs";
  return {
    stat: { id, title: over.title ?? id, description: "", unit: over.unit ?? "count", dims: [], class: "output", kind: "count" },
    from: buckets[0] ?? today,
    to: today + day,
    grain: "day",
    measure: "n",
    buckets,
    series,
    total,
    ...(q.compare ? { previous: { total: Math.round(total / 2), values: values.map((v) => (v === null ? null : Math.round(v / 2))) } } : {}),
    asOf: Date.now(),
  };
}

/** A work day as the journal wrote it (`journal.days`): today, one entry unless given. @since 1.2 */
export function day(over: Partial<Omit<ApiJournalDay, "entries">> & { entries?: Partial<ApiJournalEntry>[] } = {}): ApiJournalDay {
  const date = over.date ?? new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const entries = (over.entries ?? [{}]).map((e, i): ApiJournalEntry => ({ id: `e-${date}-${i}`, kind: "feature", title: "Built the thing", summary: "What was done and why.", outcome: "merged", start: date + 9 * 3_600_000, end: date + 11 * 3_600_000, counts: { agents: 1, prompts: 3, commands: 4, commits: 2, pages: 0, files: 5 }, project: "app", ...e }));
  return { date, headline: over.headline ?? "A day of work", writtenAt: over.writtenAt ?? date + 86_400_000, entries };
}

/** A track playing (`media.get`). @since 1.2 */
export function playing(over: Partial<ApiNowPlaying> = {}): ApiNowPlaying {
  return { app: "com.apple.Music", title: "Song", artist: "Artist", album: "Album", playing: true, duration: 240, elapsed: 60, at: Date.now(), rate: 1, artwork: null, ...over };
}

/** This week as the Journal rolled it up (`journal.week`): two threads unless given. @since 1.3 */
export function week(over: Partial<ApiJournalWeek> = {}): ApiJournalWeek {
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  const start = new Date(today).setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return { start, headline: "A week of building", themes: [{ title: "The thing", summary: "Built and shipped it." }, { title: "Fixes", summary: "Smaller fixes along the way." }], writtenAt: Date.now(), ...over };
}

/** What cmd itself uses (`app.usage`): a quiet app and background unless given. @since 1.3 */
export function appUsage(over: Partial<ApiAppUsage> = {}): ApiAppUsage {
  return { app: { cpu: 3.2, memory: 640 * 2 ** 20 }, background: { cpu: 0.8, memory: 120 * 2 ** 20 }, at: Date.now(), ...over };
}

/** The fixtures: `fixtures.agent()`, `pane()`, `window()`, `event()`, `command()` (1.1), `workspace()`; `usage()`, `classes()`, `stat()`, `day()`, `playing()` (1.2); `week()`, `appUsage()` (1.3). @since 1.0 */
export const fixtures = { agent, pane, window, event, command, workspace, usage, classes, stat, day, playing, week, appUsage };

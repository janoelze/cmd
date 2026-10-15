// The widget API's verbs and live topics, each once (docs/56, "The host API" and "Capabilities
// and grants"): the minor it came in, whether it reads, acts or asks the person, and the
// permission it needs. Everything that lists verbs derives from API and API_TOPIC: the
// verbs a cmd serves, the core's access check (widgets/api/adapter.ts) and its acts (act.ts),
// the values package.json's `act` and `ai` may hold, the grants sheet, the fake host's acts
// (@cmd/widget-api/testing) and the reference's Since and Permission columns. Adding a verb is
// a row here, its ApiMethods entry (widget-tree.ts) and its implementations, which are maps
// typed by ApiVerb: tsc names each one missing.

import type { Permission } from "./tools.ts";

/**
 * What a verb needs beyond being a widget, as package.json's `cmd.permissions` grants it:
 * - "workspace": `workspace: ["read"]` (the widget's own workspace; "all" for every one).
 * - "events": `events: [<class>]`, decided per query by data/policy.ts's widget row.
 * - "net": `net: [<host>]`, decided per URL.
 * - "ai": `ai: ["<name>"]`, the verb's own name (`ai: ["complete"]` for ai.complete).
 * - "act": `act: ["<namespace>"]` or `act: ["<namespace>.<verb>"]` (1.1).
 * - "run": `run: [<program>]`, decided per program (1.1).
 * - "media": `media: ["read"]` for a read, `media: ["control"]` for an act (1.2): what the Mac plays.
 * - null: nothing (its own state and storage, its own notifications, selecting a window).
 */
export type ApiNeed = "workspace" | "events" | "net" | "ai" | "act" | "run" | "media" | null;

/**
 * One verb. `mode`: "read" runs at once within the grant; "act" runs at once and changes
 * something of the widget's own or the board's (windows.open only right after a press);
 * "confirm" asks the person each time (unless a yes was kept), only after a press, and
 * always needs `act`. `ask` is the tools' permission the sheet asks under (docs/55);
 * `typed`: the act carries text the person reads before it runs, so it asks every time and
 * is never kept (true), or does so for a person's package while a built-in one follows the
 * levels ("person"). `press`: an "act" that also needs a press in the widget right before it.
 * `local`: never for a press from a paired device (it acts on this Mac: its clipboard, what it
 * plays). `class`: a read that also needs `events: [<class>]` beside its `needs` (1.2; "system" 1.3).
 */
export type ApiVerbSpec =
  | { since: ApiMinor; mode: "read" | "act"; needs: Exclude<ApiNeed, "act">; press?: true; local?: true; class?: "agents" | "system" }
  | { since: ApiMinor; mode: "confirm"; needs: "act"; ask: Permission; typed?: true | "person" };

/** A minor of API 1. */
export type ApiMinor = "1.0" | "1.1" | "1.2" | "1.3";

/** Every verb of the API, in the order cmd.env.verbs lists them. */
export const API = {
  "workspace.get": { since: "1.0", mode: "read", needs: "workspace" },
  "workspace.windows": { since: "1.0", mode: "read", needs: "workspace" },
  "workspace.selected": { since: "1.0", mode: "read", needs: "workspace" },
  "agents.list": { since: "1.0", mode: "read", needs: "workspace" },
  "agents.get": { since: "1.0", mode: "read", needs: "workspace" },
  "terminals.list": { since: "1.0", mode: "read", needs: "workspace" },
  "terminals.read": { since: "1.0", mode: "read", needs: "workspace" },
  "terminals.waitFor": { since: "1.0", mode: "read", needs: "workspace" },
  "windows.list": { since: "1.0", mode: "read", needs: "workspace" },
  "windows.open": { since: "1.0", mode: "act", needs: null, press: true }, // only right after the person pressed something in the widget
  "windows.select": { since: "1.0", mode: "act", needs: null }, // within the widget's scope: its workspace, or all with "all"
  "events.query": { since: "1.0", mode: "read", needs: "events" },
  "events.stats": { since: "1.0", mode: "read", needs: "events" },
  "git.status": { since: "1.0", mode: "read", needs: "workspace" },
  "git.diff": { since: "1.0", mode: "read", needs: "workspace" },
  "git.worktrees": { since: "1.0", mode: "read", needs: "workspace" },
  "actions.list": { since: "1.0", mode: "read", needs: "workspace" },
  "notify.send": { since: "1.0", mode: "act", needs: null }, // through the notification center, muted with the window
  "state.get": { since: "1.0", mode: "read", needs: null },
  "state.set": { since: "1.0", mode: "act", needs: null },
  "state.history": { since: "1.0", mode: "act", needs: null },
  "net.fetch": { since: "1.0", mode: "read", needs: "net" },
  "ai.complete": { since: "1.0", mode: "read", needs: "ai" },
  // 1.1: acting (each asks the person, docs/55) and running a program through the core.
  "agents.start": { since: "1.1", mode: "confirm", needs: "act", ask: "agents", typed: "person" }, // the prompt is the whole act
  "agents.send": { since: "1.1", mode: "confirm", needs: "act", ask: "type", typed: true },
  "agents.stop": { since: "1.1", mode: "confirm", needs: "act", ask: "stop" },
  "terminals.type": { since: "1.1", mode: "confirm", needs: "act", ask: "type", typed: true },
  "terminals.open": { since: "1.1", mode: "confirm", needs: "act", ask: "show" }, // a command typed, not run
  "actions.run": { since: "1.1", mode: "confirm", needs: "act", ask: "run" }, // a risky one is refused before any sheet
  "windows.close": { since: "1.1", mode: "confirm", needs: "act", ask: "stop" }, // "show" for a window the widget opened
  "run.exec": { since: "1.1", mode: "read", needs: "run" }, // read-only commands only (lib/policy.ts), through the core
  // 1.2: what the built-ins' ports needed (docs/57, wave 2).
  "actions.stop": { since: "1.2", mode: "confirm", needs: "act", ask: "stop" }, // ⌃C to a running action of the workspace
  "events.classes": { since: "1.2", mode: "read", needs: null }, // what the log's classes are, as Settings names them: no data
  "terminals.usage": { since: "1.2", mode: "read", needs: "workspace" }, // CPU and memory of the workspace's terminals
  "stats.query": { since: "1.2", mode: "read", needs: "events" }, // the stat's class, decided per query; the workspace forced unless "all"
  "journal.days": { since: "1.2", mode: "read", needs: "workspace", class: "agents" }, // the workspace's written days; never writes one
  "media.get": { since: "1.2", mode: "read", needs: "media" }, // media: ["read"]
  "media.control": { since: "1.2", mode: "act", needs: "media", press: true, local: true }, // media: ["control"], right after a press on this Mac
  "clipboard.write": { since: "1.2", mode: "act", needs: null, press: true, local: true }, // text, right after a press on this Mac
  // 1.3: the package's own storage (widgets/storage.ts), in the scope it names: no permission.
  "storage.get": { since: "1.3", mode: "read", needs: null },
  "storage.set": { since: "1.3", mode: "act", needs: null },
  "storage.delete": { since: "1.3", mode: "act", needs: null },
  "storage.keys": { since: "1.3", mode: "read", needs: null },
  "storage.history": { since: "1.3", mode: "act", needs: null },
  // 1.3: what the native views read (docs/57, "1.3 additions" C4–C12).
  "journal.week": { since: "1.3", mode: "read", needs: "workspace", class: "agents" }, // the week the Journal wrote; never writes one
  "workspaces.list": { since: "1.3", mode: "read", needs: "workspace" }, // every workspace's id and name, with "all"; never a folder
  "agents.select": { since: "1.3", mode: "act", needs: null }, // within the widget's scope, as windows.select; marks the agent seen
  "terminals.rerun": { since: "1.3", mode: "confirm", needs: "act", ask: "type", typed: "person" }, // the command cmd's log recorded, never the widget's text
  "app.usage": { since: "1.3", mode: "read", needs: "events", class: "system" }, // cmd's own CPU and memory, as the Task Manager shows it
} as const satisfies Record<string, ApiVerbSpec>;

export type ApiVerb = keyof typeof API;
/** Every verb of the API that crosses the wire. */
export const API_VERBS = Object.keys(API) as ApiVerb[];

/** The verbs that ask the person (`act: [<namespace>]`), act.ts's. */
export type ApiActVerb = { [V in ApiVerb]: (typeof API)[V]["needs"] extends "act" ? V : never }[ApiVerb];
export const API_ACT_VERBS = API_VERBS.filter((v): v is ApiActVerb => API[v].needs === "act");
export const isActVerb = (v: string): v is ApiActVerb => (API_ACT_VERBS as string[]).includes(v);
/** What package.json's `act` may name: the namespaces of the acts ("agents"), or one of their verbs. */
export type ApiActNamespace = ApiActVerb extends `${infer N}.${string}` ? N : never;
export const API_ACT_NAMESPACES = [...new Set(API_ACT_VERBS.map((v) => v.split(".")[0]!))] as ApiActNamespace[];
/** What package.json's `ai` may name: the ai verbs' names ("complete"). */
export const API_AI_USES = API_VERBS.filter((v) => API[v].needs === "ai").map((v) => v.split(".")[1]!);

/** What package.json's `media` may name: "read" (media.get), "control" (media.control). */
export const API_MEDIA_USES = ["read", "control"] as const;
/** The `media` value a verb needs: "read" for a read, "control" for an act. */
export const mediaUse = (v: ApiVerb): (typeof API_MEDIA_USES)[number] => (API[v].mode === "read" ? "read" : "control");
/** The event class a verb needs beside its `needs` (journal.days: "agents", app.usage: "system"), or null. */
export const verbClass = (v: string): string | null => ((API as Record<string, ApiVerbSpec>)[v] as { class?: string } | undefined)?.class ?? null;
/** Whether a verb is never for a press from a paired device: it acts on this Mac (the clipboard, what it plays). */
export const localOnly = (v: string): boolean => ((API as Record<string, ApiVerbSpec>)[v] as { local?: true } | undefined)?.local === true;

/** Whether a verb needs a press in the widget right before it, taking it (one each): every act that asks, and windows.open. */
export const needsPress = (v: string): boolean => {
  const row = (API as Record<string, ApiVerbSpec>)[v];
  return !!row && (row.mode === "confirm" || ("press" in row && row.press === true));
};

/** A typed act asks every time and is never kept: always, or for a person's package only. */
export const actTyped = (v: ApiActVerb, builtin: boolean): boolean => {
  const t = (API[v] as ApiVerbSpec & { typed?: true | "person" }).typed;
  return t === true || (t === "person" && !builtin);
};

/** Live topics: what the hooks and `use()`s subscribe to, each the live form of one read, needing what it needs. */
export const API_TOPIC = {
  workspace: { verb: "workspace.get" },
  agents: { verb: "agents.list" },
  terminals: { verb: "terminals.list" },
  windows: { verb: "windows.list" },
  events: { verb: "events.query" },
  git: { verb: "git.status" },
  actions: { verb: "actions.list" },
  terminalUsage: { verb: "terminals.usage" }, // 1.2: useTerminalUsage
  storage: { verb: "storage.get" }, // 1.3: useStorage, one key of one scope ({ scope, key })
  stats: { verb: "stats.query" }, // 1.3: useStat, again after the stat changed (and each minute for time)
  journal: { verb: "journal.days" }, // 1.3: useJournal, again when a day is written
  workspaces: { verb: "workspaces.list" }, // 1.3: useWorkspaces
  appUsage: { verb: "app.usage" }, // 1.3: useAppUsage, every 2 s while subscribed
} as const satisfies Record<string, { verb: ApiVerb }>;

export type ApiTopic = keyof typeof API_TOPIC;
export const API_TOPICS = Object.keys(API_TOPIC) as ApiTopic[];
/** The verb a topic is the live form of ("agents.list" for agents), or undefined for a topic that isn't one. */
export const topicVerb = (t: string): ApiVerb | undefined => (API_TOPIC as Record<string, { verb: ApiVerb }>)[t]?.verb;

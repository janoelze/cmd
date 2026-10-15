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
 * - null: nothing (its own state, its own notifications, selecting a window).
 */
export type ApiNeed = "workspace" | "events" | "net" | "ai" | "act" | "run" | null;

/**
 * One verb. `mode`: "read" runs at once within the grant; "act" runs at once and changes
 * something of the widget's own or the board's (windows.open only right after a press);
 * "confirm" asks the person each time (unless a yes was kept), only after a press, and
 * always needs `act`. `ask` is the tools' permission the sheet asks under (docs/55);
 * `typed`: the act carries text the person reads before it runs, so it asks every time and
 * is never kept (true), or does so for a person's package while a built-in one follows the
 * levels ("person"). `press`: an "act" that also needs a press in the widget right before it.
 */
export type ApiVerbSpec =
  | { since: ApiMinor; mode: "read" | "act"; needs: Exclude<ApiNeed, "act">; press?: true }
  | { since: ApiMinor; mode: "confirm"; needs: "act"; ask: Permission; typed?: true | "person" };

/** A minor of API 1. */
export type ApiMinor = "1.0" | "1.1" | "1.2";

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
} as const satisfies Record<string, { verb: ApiVerb }>;

export type ApiTopic = keyof typeof API_TOPIC;
export const API_TOPICS = Object.keys(API_TOPIC) as ApiTopic[];
/** The verb a topic is the live form of ("agents.list" for agents), or undefined for a topic that isn't one. */
export const topicVerb = (t: string): ApiVerb | undefined => (API_TOPIC as Record<string, { verb: ApiVerb }>)[t]?.verb;

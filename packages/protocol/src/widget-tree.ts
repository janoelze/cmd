// The widget API's wire contract, API 1 (docs/56-widgets-v3.md, "The host API" and "The
// view"). A widget process runs React against @cmd/widget-api; its reconciler turns the
// view into a tree of API elements (never kit components) and sends it once, then patches;
// its `cmd.*` calls and hooks become `call` and `subscribe` messages. The core answers with
// `result`s and `event`s and forwards what the person does in the window as `interaction`s.
//
// Everything here is the promise to widget authors: within API 1 it only grows (new
// verbs, elements, optional props, message fields). The core's adapter (widgets/api/adapter.ts)
// and the renderer's element table (windows/package/elements.tsx) are typed against it.
//
//   process → core: hello, tree, patch, call, subscribe, unsubscribe, log, error
//   core → process: ready, result, event, interaction, config, env, resync

import type { ApiBox, ApiElement } from "./widget-elements.ts";
import type { ApiTopic, ApiVerb } from "./widget-verbs.ts";
import type { ApiEventClass, ApiJournalDay, ApiJournalQuery, ApiMediaCommand, ApiNowPlaying, ApiStatQuery, ApiStatResult, ApiTerminalUsage, ApiUsageQuery } from "./widget-tree-1.2.ts";
import type { ApiStorageMigrate, ApiStorageQuery, ApiStorageScope, WidgetMigrated } from "./widget-tree-1.3.ts";
import type { ApiAppUsage, ApiJournalWeek, ApiJournalWeekQuery, ApiRerun, ApiWorkspaceName } from "./widget-tree-1.3.ts";

// ── versions ────────────────────────────────────────────

/** The API major this file describes. */
export const WIDGET_API = 1;
/** The minor served within it; a minor only adds. 1.1 added the acts (docs/56, phase 4) and `run`; 1.2 the window-content elements and the built-ins' verbs (docs/57); 1.3 storage in three scopes (`cmd.storage`). */
export const WIDGET_API_MINOR = 3;

// ── the tree ────────────────────────────────────────────

/** What a prop may hold on the wire: JSON, where a function became a handler reference. */
export type WireValue = null | boolean | number | string | HandlerRef | WireValue[] | { [key: string]: WireValue };

/**
 * A function prop (or a function inside a prop: a menu entry's `run`, an action's `run`),
 * replaced by its id in the process's handler registry. The id is stable while the
 * element keeps the same function prop, and is never reused within a process.
 */
export interface HandlerRef {
  $handler: number;
}

/**
 * An element: `type` is an API element name, `props` JSON with handler refs, no `children`
 * prop. One prop is the wire's own: `$hidden: true` while React hides the element (a
 * Suspense fallback shows instead); the renderer doesn't draw it. A hidden text is "".
 */
export interface TreeElement {
  id: number;
  type: ApiElement;
  props: Record<string, WireValue>;
  children: TreeNode[];
}

/** A string child (a Text's words). */
export interface TreeText {
  id: number;
  type: "#text";
  text: string;
}

export type TreeNode = TreeElement | TreeText;

/** The parent id of the root's own children: the tree is a list (a component may return a fragment). */
export const TREE_ROOT = 0;

/**
 * One change to the tree. A patch's ops apply in order, each to the tree as the ops
 * before it left it; ids are unique for the process's life (a removed id is never reused).
 *
 * - `insert`: a new subtree at `index` among `parent`'s children (TREE_ROOT for the top).
 * - `move`: an existing node to `index` among `parent`'s children (its index counted
 *   after taking it out). React moves keyed rows this way.
 * - `remove`: a node and its subtree.
 * - `props`: props set (added or changed) and props unset, on an element.
 * - `text`: a text node's new text.
 */
export type PatchOp =
  | { op: "insert"; parent: number; index: number; node: TreeNode }
  | { op: "move"; id: number; parent: number; index: number }
  | { op: "remove"; id: number }
  | { op: "props"; id: number; set: Record<string, WireValue>; unset: string[] }
  | { op: "text"; id: number; text: string };

// ── messages ────────────────────────────────────────────

/** A widget's process announces itself; the core picks the adapter for `api` and answers `ready`. */
export interface WidgetHello {
  kind: "hello";
  api: number;
  /** The API minor the process's @cmd/widget-api was built for. */
  minor: number;
  /** package.json's name and version, and the widget's id in `cmd.widgets[]`. */
  package: string;
  version: string;
  widget: string;
}

/**
 * The whole tree, after hello and again on `resync`. `rev` counts trees and patches
 * from 1; the renderer applies a patch only on the rev after its last and asks for a
 * `resync` otherwise.
 */
export interface WidgetTree {
  kind: "tree";
  rev: number;
  nodes: TreeNode[];
}

/** What one React commit changed. */
export interface WidgetPatch {
  kind: "patch";
  rev: number;
  ops: PatchOp[];
}

/** An API verb. `params` is the verb's arguments in order, as the JS call had them (`["w-1"]` for `select("w-1")`). */
export interface WidgetCall {
  kind: "call";
  id: number;
  method: ApiVerb;
  params: WireValue[];
}

/**
 * Live data: the core sends an `event` for `id` at once with the current value, then
 * on every change. For `events` the data is the new events (the first, the query's
 * result); for every other topic it is the whole current value, replacing the last.
 * A subscription the core refuses (the grant lacks what the topic needs) gets a `result`
 * with `ok: false` under its `id` instead, and no events: it has ended, and the live hook
 * throws the error on its next render (the reconciler's boundary shows it).
 */
export interface WidgetSubscribe {
  kind: "subscribe";
  id: number;
  topic: ApiTopic;
  query: TopicQuery[ApiTopic] | null;
}

export interface WidgetUnsubscribe {
  kind: "unsubscribe";
  id: number;
}

/** console.* in the process, to `cmd widget dev`'s terminal and the widget's log. */
export interface WidgetLog {
  kind: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** A render error (the reconciler's boundary caught it; the process stays up and shows a Callout) or an uncaught one. */
export interface WidgetError {
  kind: "error";
  message: string;
  stack: string | null;
  /** React's component stack, for a render error. */
  componentStack: string | null;
}

/** 1.3: `migrated` answers a `ready` with `migrate` (widget-tree-1.3.ts). */
export type WidgetOut = WidgetHello | WidgetTree | WidgetPatch | WidgetCall | WidgetSubscribe | WidgetUnsubscribe | WidgetLog | WidgetError | WidgetMigrated;

/** The answer to hello: what the process renders with before anything else. */
export interface WidgetReady {
  kind: "ready";
  env: WidgetEnv;
  /** This window's config values. Secret fields are never here: a widget never holds a secret (net.fetch's `auth` names one). */
  config: Record<string, WireValue>;
  /** This window's stored state (`cmd.state`, `useStoredState`), so the first render has it. */
  state: Record<string, WireValue>;
  /** 1.3: the places whose stored data is older than package.json's `cmd.storage.version`, in order (package, workspace, window): run the migration for each and say `migrated` after each, before anything reads storage. */
  migrate?: ApiStorageMigrate[];
}

/** A call's answer. A refused call (no permission, a verb this core lacks) is `ok: false` and the process lives on. */
export type WidgetResult =
  | { kind: "result"; id: number; ok: true; value: WireValue }
  | { kind: "result"; id: number; ok: false; error: ApiError };

export interface ApiError {
  message: string;
  /**
   * "permission": `permission` names what to add to package.json; "unknown": a verb this core
   * doesn't serve; "failed": it ran and failed; "denied" (1.1): the person said no to an act,
   * or turned that kind of act off.
   */
  code: "permission" | "unknown" | "invalid" | "failed" | "denied";
  /** What to add to package.json's `cmd.permissions`, as written there: `net: ["api.github.com"]`, `ai: ["complete"]`, `workspace: ["read"]`. */
  permission?: string;
}

export interface WidgetEventMessage {
  kind: "event";
  sub: number;
  data: WireValue;
}

/** The person acted on an element: `handler` is the HandlerRef's id, `event` the prop's name (`onClick`, `onChange`, or `run` in a menu entry), `value` what an input reports. */
export interface WidgetInteraction {
  kind: "interaction";
  handler: number;
  event: string;
  value?: WireValue;
}

export interface WidgetConfig {
  kind: "config";
  config: Record<string, WireValue>;
}

export interface WidgetEnvMessage {
  kind: "env";
  env: WidgetEnv;
}

/** The renderer lost track (a rev skipped, a window reopened): send the whole tree again. */
export interface WidgetResync {
  kind: "resync";
}

export type WidgetIn = WidgetReady | WidgetResult | WidgetEventMessage | WidgetInteraction | WidgetConfig | WidgetEnvMessage | WidgetResync;

/** `cmd.env`: what the process knows of where it runs. */
export interface WidgetEnv {
  /** cmd's version ("0.32.0"). */
  version: string;
  /** The API served. */
  api: { major: number; minor: number };
  /** The verbs this core serves (`cmd.env.has`). */
  verbs: ApiVerb[];
  /** 1.2: the elements this cmd draws (`cmd.env.has`); a cmd before 1.2 sends none, and draws 1.1's. */
  elements?: ApiElement[];
  theme: "dark" | "light";
  /** The window's size class. */
  size: "narrow" | "regular" | "wide";
  /**
   * 1.3: the window content's size in px (each side rounded down to 8; at most every 200 ms while it
   * resizes), for logic that needs numbers (how many rows fit). Null until cmd has measured the
   * window; a cmd before 1.3 sends none. A layout per size is an `Adapt`, not this.
   */
  box?: ApiBox | null;
  placement: "board" | "sidebar";
}

// ── the verbs ───────────────────────────────────────────

/** What each verb takes (its arguments, in order) and returns. */
export interface ApiMethods {
  "workspace.get": { params: []; result: ApiWorkspace };
  "workspace.windows": { params: []; result: ApiWindow[] };
  "workspace.selected": { params: []; result: ApiWindow | null };
  "agents.list": { params: [query?: ApiAgentQuery]; result: ApiAgent[] };
  "agents.get": { params: [id: string]; result: ApiAgent | null };
  "terminals.list": { params: [query?: ApiScopeQuery]; result: ApiTerminal[] };
  "terminals.read": { params: [id: string, opts?: { lines?: number }]; result: ApiTerminalScreen };
  "terminals.waitFor": { params: [id: string, pattern: string, opts?: { timeoutMs?: number }]; result: { matched: boolean; line: string | null } };
  "windows.list": { params: [query?: ApiScopeQuery]; result: ApiWindow[] };
  "windows.open": { params: [target: string]; result: { id: string } };
  "windows.select": { params: [id: string]; result: null };
  "events.query": { params: [query: ApiEventQuery]; result: ApiEvent[] };
  "events.stats": { params: [query: ApiEventQuery]; result: ApiEventStats };
  "git.status": { params: []; result: ApiGitStatus | null };
  "git.diff": { params: [file?: string]; result: { text: string; clipped: boolean } };
  "git.worktrees": { params: []; result: ApiGitWorktree[] };
  "actions.list": { params: []; result: ApiAction[] };
  "notify.send": { params: [note: ApiNotification]; result: null };
  "state.get": { params: [key: string]; result: WireValue };
  "state.set": { params: [key: string, value: WireValue]; result: null };
  "state.history": { params: [key: string, value: number | null, max?: number]; result: number[] };
  "net.fetch": { params: [url: string, init?: ApiFetchInit]; result: ApiFetchResponse };
  "ai.complete": { params: [req: ApiCompletionRequest]; result: ApiCompletion };
  "agents.start": { params: [req: ApiAgentStart]; result: ApiStarted };
  "agents.send": { params: [id: string, text: string]; result: null };
  "agents.stop": { params: [id: string]; result: null };
  "terminals.type": { params: [id: string, text: string, opts?: { submit?: boolean }]; result: null };
  "terminals.open": { params: [req?: ApiTerminalOpen]; result: { id: string } };
  "actions.run": { params: [name: string, opts?: ApiActionRunOptions]; result: ApiActionStarted };
  "windows.close": { params: [id: string]; result: null };
  "run.exec": { params: [program: string, args?: string[], opts?: ApiRunOptions]; result: ApiRunResult };
  // 1.2 (widget-tree-1.2.ts)
  "actions.stop": { params: [name: string]; result: null };
  "events.classes": { params: []; result: ApiEventClass[] };
  "terminals.usage": { params: [query?: ApiUsageQuery]; result: ApiTerminalUsage[] };
  "stats.query": { params: [query: ApiStatQuery]; result: ApiStatResult };
  "journal.days": { params: [query?: ApiJournalQuery]; result: ApiJournalDay[] };
  "media.get": { params: []; result: ApiNowPlaying | null };
  "media.control": { params: [command: ApiMediaCommand | null, opts?: { seek?: number }]; result: null };
  "clipboard.write": { params: [text: string]; result: null };
  // 1.3 (widget-tree-1.3.ts): the scope names where; the core knows which window, workspace and package.
  "storage.get": { params: [scope: ApiStorageScope, key: string]; result: WireValue };
  "storage.set": { params: [scope: ApiStorageScope, key: string, value: WireValue | undefined]; result: null };
  "storage.delete": { params: [scope: ApiStorageScope, key: string]; result: null };
  "storage.keys": { params: [scope: ApiStorageScope, prefix?: string]; result: string[] };
  "storage.history": { params: [scope: ApiStorageScope, key: string, value?: number | null, max?: number]; result: number[] };
  // 1.3: what the native views read (widget-tree-1.3.ts).
  "journal.week": { params: [query?: ApiJournalWeekQuery]; result: ApiJournalWeek | null };
  "workspaces.list": { params: []; result: ApiWorkspaceName[] };
  "agents.select": { params: [id: string]; result: null };
  "terminals.rerun": { params: [key: string]; result: ApiRerun };
  "app.usage": { params: []; result: ApiAppUsage };
}

/** ApiMethods has exactly the verbs of API_VERBS (tsc fails here otherwise). */
export const API_METHODS_MATCH_VERBS: [Exclude<ApiVerb, keyof ApiMethods>, Exclude<keyof ApiMethods, ApiVerb>] extends [never, never] ? true : false = true;

/** A topic's query, and the data of its events. */
export interface TopicQuery {
  workspace: null;
  agents: ApiAgentQuery;
  terminals: ApiScopeQuery;
  windows: ApiScopeQuery;
  events: ApiEventQuery;
  git: null;
  actions: null;
  terminalUsage: ApiUsageQuery;
  storage: ApiStorageQuery;
  stats: ApiStatQuery;
  journal: ApiJournalQuery;
  workspaces: null;
  appUsage: null;
}
export interface TopicData {
  workspace: ApiWorkspace;
  agents: ApiAgent[];
  terminals: ApiTerminal[];
  windows: ApiWindow[];
  /** The events since the last one sent (the first: the query's result). */
  events: ApiEvent[];
  git: ApiGitStatus | null;
  actions: ApiAction[];
  terminalUsage: ApiTerminalUsage[];
  /** The key's value now, or null. */
  storage: WireValue;
  stats: ApiStatResult;
  journal: ApiJournalDay[];
  workspaces: ApiWorkspaceName[];
  appUsage: ApiAppUsage;
}

// ── the data, in the product's words ────────────────────

/** "workspace": the widget's own (the default); "all": every workspace, which needs `workspace: ["all"]`. */
export interface ApiScopeQuery {
  scope?: "workspace" | "all";
}
export type ApiAgentQuery = ApiScopeQuery;

export interface ApiWorkspace {
  id: string;
  name: string;
  /** Its folder, or null for one without. */
  root: string | null;
  branch: string | null;
}

export interface ApiWindow {
  id: string;
  /** "terminal", "browser", "files", "text", or a widget's kind ("pkg:ci-runs/ci"). */
  kind: string;
  title: string;
  workspaceId: string;
  selected: boolean;
}

/** An agent's state; "waiting" is waiting for the person (a question, a permission). */
export type ApiAgentState = "starting" | "working" | "idle" | "waiting" | "done" | "exited" | "failed";

/** A status light: what ListRowIcon's `light` and StatusDot's `state` take. */
export type ApiLight = "needs" | "unseen" | "working" | "done" | "idle" | "off" | ApiTone;

export interface ApiAgent {
  id: string;
  /** What cmd calls it, else its kind ("Claude"). */
  name: string;
  /** "claude", "codex", … */
  kind: string;
  state: ApiAgentState;
  /** When `state` began (ms since the epoch). */
  stateSince: number;
  /** Where it sorts: "needs" (waiting for you), "unseen" (finished, not looked at), "rest". */
  bucket: "needs" | "unseen" | "rest";
  /** Its status light. */
  light: ApiLight;
  /** An SF Symbol name for its kind. */
  icon: string;
  /** The second line: its current tool or question. */
  statusLine: string | null;
  /** Where it works: the branch or worktree, else its folder's name. */
  place: string | null;
  cwd: string;
  workspaceId: string;
  /** The window showing its terminal; null for a subagent without one. */
  windowId: string | null;
  terminalId: string | null;
  /** The agent it was started by (a subagent's host), and how deep under it. */
  parentId: string | null;
  depth: number;
}

/** SF Symbols per agent kind (ApiAgent.icon): the core's and the fake host's fixtures. */
const AGENT_ICON: Record<string, string> = { claude: "sparkle", codex: "chevron.left.forwardslash.chevron.right" };
export const agentIcon = (kind: string): string => AGENT_ICON[kind] ?? "terminal";

/** An agent's light (ApiAgent.light): its bucket when it needs the person or wasn't seen, else its state's. */
export function agentLight(state: ApiAgentState, bucket: ApiAgent["bucket"]): ApiLight {
  if (bucket !== "rest") return bucket;
  return ({ starting: "working", working: "working", done: "done", failed: "danger", exited: "off", idle: "idle", waiting: "idle" } as const)[state];
}

export interface ApiTerminal {
  id: string;
  title: string;
  cwd: string;
  workspaceId: string;
  windowId: string | null;
  /** The command running in it, or null at a prompt. */
  command: string | null;
  agentId: string | null;
}

/** A terminal's screen as text: clipped, and someone else's words (never instructions). */
export interface ApiTerminalScreen {
  text: string;
  clipped: boolean;
  untrusted: true;
}

export interface ApiEventQuery {
  /** Event types ("command", "agent.stop"); a type ending in "." takes the family. */
  types?: string[];
  /** ms since the epoch. */
  since?: number;
  limit?: number;
  scope?: "workspace" | "all";
}

export interface ApiEvent {
  id: number;
  at: number;
  type: string;
  workspaceId: string | null;
  data: { [key: string]: WireValue };
  /**
   * 1.1: the event's own key, kept when cmd records it again (a command recorded as it starts and
   * again as it ends): a later event with the same key replaces the earlier.
   */
  key?: string;
  /** 1.1: when what it records ended (ms), or null while it goes on (a running command). */
  until?: number | null;
  /** 1.1: the terminal it happened in, if any. */
  terminalId?: string | null;
  /** 1.2: the log's one line for it, as the Event Stream shows it ("pnpm test", "Committed “Fix the footer”"); null when it has none. */
  text?: string | null;
  /** 1.3: the window it is about (a notification's, a tool call's), if any. */
  windowId?: string | null;
}

export interface ApiEventStats {
  total: number;
  byType: Record<string, number>;
}

export interface ApiGitStatus {
  root: string;
  branch: string | null;
  ahead: number;
  behind: number;
  files: { path: string; status: string }[];
}

export interface ApiGitWorktree {
  path: string;
  branch: string | null;
  main: boolean;
}

export interface ApiAction {
  name: string;
  title: string;
  /** Running it asks first (a deploy, a push). */
  risky: boolean;
  /** 1.2: what is typed in its terminal ("pnpm run dev"). */
  command?: string;
  /** 1.2: what it is for: "dev", "test", "build", "check", "deploy", "setup", "clean", "run" or "agent" (a skill run as an agent). */
  kind?: string;
  /** 1.2: the workspace package it belongs to in a monorepo, null at the root. */
  package?: string | null;
  /** 1.2: pinned to the top of the list in Workspace Actions. */
  pinned?: boolean;
  /** 1.2: the one to show big (usually dev); at most one is. */
  primary?: boolean;
  /** 1.2: its latest run in this folder is still going (from any window). */
  running?: boolean;
  /** 1.2: the terminal its latest run is in, null when it hasn't run here. */
  terminalId?: string | null;
  /** 1.2: the local address it serves while it runs (http://localhost:5173/), null when none or not running. */
  url?: string | null;
  /** 1.2: how its latest run ended: the exit status, null while it runs or when it hasn't. */
  exitCode?: number | null;
}

/** How `cmd.actions.run` runs an action. */
export interface ApiActionRunOptions {
  /** 1.2: one that is running is stopped (⌃C) and run again in its terminal: Restart. An older cmd runs it only when it isn't running. */
  restart?: boolean;
}

/** A request the core makes for the widget (the process has no network of its own). */
export interface ApiFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * A secret config field's key: the core attaches its value as the field's package.json
   * binding says, and only to the host the field is bound to. The widget never sees it.
   */
  auth?: string;
}

/** The response, as text (clipped past the core's limit). */
export interface ApiFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  clipped: boolean;
}

/** A completion from the person's AI, through cmd's AI service, with no tools. */
export interface ApiCompletionRequest {
  prompt: string;
  system?: string;
  /** A JSON Schema: the answer is an object of that shape instead of text. */
  schema?: { [key: string]: WireValue };
  maxTokens?: number;
}

/** Text, or an object when the request had a schema; with the tokens it used. */
export type ApiCompletion = ({ text: string } | { object: WireValue }) & { usage: { input: number; output: number } };

/** An agent to start (`cmd.agents.start`): its kind, its task, and where it works. */
export interface ApiAgentStart {
  /** "claude" (the default) or "codex". */
  kind?: "claude" | "codex";
  /** The task, as a complete brief. 1.3: none starts an interactive session the person types into. */
  prompt?: string;
  /** Where it works: a folder in the workspace's (relative to it, or absolute inside it); the workspace's folder by default. */
  cwd?: string;
}

/** An agent started: its id, and its terminal and window (null while it has none). */
export interface ApiStarted {
  id: string;
  terminalId: string | null;
  windowId: string | null;
}

/** A terminal to open (`cmd.terminals.open`): where, and a command typed at its prompt but not run. */
export interface ApiTerminalOpen {
  /** A folder in the workspace's (relative to it, or absolute inside it); the workspace's folder by default. */
  cwd?: string;
  /** One line typed at the prompt, never run: the person presses Return. */
  command?: string;
}

/** A Workspace Action started (`cmd.actions.run`): the terminal it runs in, and false when it was already running there. */
export interface ApiActionStarted {
  terminalId: string;
  started: boolean;
}

/** How `cmd.run` runs a program. */
export interface ApiRunOptions {
  /** A folder in the workspace's or one the widget may read (`read`); the workspace's folder by default. */
  cwd?: string;
  /** Stop it after this long: 10 s by default, 30 s at most. */
  timeoutMs?: number;
}

/** What a program printed and how it ended. `code` is null when it was stopped (timed out). */
export interface ApiRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Its output was longer than the core keeps (64 KB of stdout, 16 KB of stderr). */
  clipped: boolean;
}

export interface ApiNotification {
  /** Notifications with the same key replace each other. */
  key: string;
  title: string;
  body?: string;
  urgent?: boolean;
}

/** A tone: what ListRowIcon's, Badge's and Text's colours are named by. */
export type ApiTone = "neutral" | "accent" | "success" | "warning" | "danger";

export * from "./widget-elements.ts";
export * from "./widget-verbs.ts";
export * from "./widget-tree-1.2.ts";
export * from "./widget-tree-1.3.ts";

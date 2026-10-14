// The widget API's wire contract, API 1 (docs/56-widgets-v3.md, "The host API" and "The
// view"). A widget process runs React against @cmd/widget-api; its reconciler turns the
// view into a tree of API elements (never kit components) and sends it once, then patches;
// its `cmd.*` calls and hooks become `call` and `subscribe` messages. The core answers with
// `result`s and `event`s and forwards what the person does in the window as `interaction`s.
//
// Everything here is the promise to widget authors: within API 1 it only grows (new
// verbs, elements, optional props, message fields). The core's adapter (widgets/api/v1.ts)
// and the renderer's element table (windows/package/elements.tsx) are typed against it.
//
//   process → core: hello, tree, patch, call, subscribe, unsubscribe, log, error
//   core → process: ready, result, event, interaction, config, env, resync

// ── versions ────────────────────────────────────────────

/** The API major this file describes. */
export const WIDGET_API = 1;
/** The minor served within it; a minor only adds. 1.1 added the acts (docs/56, phase 4) and `run`. */
export const WIDGET_API_MINOR = 1;

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

export type WidgetOut = WidgetHello | WidgetTree | WidgetPatch | WidgetCall | WidgetSubscribe | WidgetUnsubscribe | WidgetLog | WidgetError;

/** The answer to hello: what the process renders with before anything else. */
export interface WidgetReady {
  kind: "ready";
  env: WidgetEnv;
  /** This window's config values. Secret fields are never here: a widget never holds a secret (net.fetch's `auth` names one). */
  config: Record<string, WireValue>;
  /** This window's stored state (`cmd.state`, `useStoredState`), so the first render has it. */
  state: Record<string, WireValue>;
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
  theme: "dark" | "light";
  /** The window's size class. */
  size: "narrow" | "regular" | "wide";
  placement: "board" | "sidebar";
}

// ── the verbs ───────────────────────────────────────────

/** Every verb of API 1 that crosses the wire. The core's capability table (widgets/api/access.ts) has a row for each. */
export const API_VERBS = [
  "workspace.get",
  "workspace.windows",
  "workspace.selected",
  "agents.list",
  "agents.get",
  "terminals.list",
  "terminals.read",
  "terminals.waitFor",
  "windows.list",
  "windows.open",
  "windows.select",
  "events.query",
  "events.stats",
  "git.status",
  "git.diff",
  "git.worktrees",
  "actions.list",
  "notify.send",
  "state.get",
  "state.set",
  "state.history",
  "net.fetch",
  "ai.complete",
  // 1.1: acting (each asks the person, docs/55) and running a program through the core.
  "agents.start",
  "agents.send",
  "agents.stop",
  "terminals.type",
  "terminals.open",
  "actions.run",
  "windows.close",
  "run.exec",
] as const;
export type ApiVerb = (typeof API_VERBS)[number];

/** The API minor each verb came in: a widget that may run on an older cmd checks `cmd.env.has(verb)` before one newer than 1.0. */
export const API_SINCE: { [V in ApiVerb]: "1.0" | "1.1" } = {
  "workspace.get": "1.0",
  "workspace.windows": "1.0",
  "workspace.selected": "1.0",
  "agents.list": "1.0",
  "agents.get": "1.0",
  "terminals.list": "1.0",
  "terminals.read": "1.0",
  "terminals.waitFor": "1.0",
  "windows.list": "1.0",
  "windows.open": "1.0",
  "windows.select": "1.0",
  "events.query": "1.0",
  "events.stats": "1.0",
  "git.status": "1.0",
  "git.diff": "1.0",
  "git.worktrees": "1.0",
  "actions.list": "1.0",
  "notify.send": "1.0",
  "state.get": "1.0",
  "state.set": "1.0",
  "state.history": "1.0",
  "net.fetch": "1.0",
  "ai.complete": "1.0",
  "agents.start": "1.1",
  "agents.send": "1.1",
  "agents.stop": "1.1",
  "terminals.type": "1.1",
  "terminals.open": "1.1",
  "actions.run": "1.1",
  "windows.close": "1.1",
  "run.exec": "1.1",
};

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
  "actions.run": { params: [name: string]; result: ApiActionStarted };
  "windows.close": { params: [id: string]; result: null };
  "run.exec": { params: [program: string, args?: string[], opts?: ApiRunOptions]; result: ApiRunResult };
}

/** ApiMethods has exactly the verbs of API_VERBS (tsc fails here otherwise). */
export const API_METHODS_MATCH_VERBS: [Exclude<ApiVerb, keyof ApiMethods>, Exclude<keyof ApiMethods, ApiVerb>] extends [never, never] ? true : false = true;

/** Live topics: what the hooks and `use()`s subscribe to. */
export const API_TOPICS = ["workspace", "agents", "terminals", "windows", "events", "git", "actions"] as const;
export type ApiTopic = (typeof API_TOPICS)[number];

/** A topic's query, and the data of its events. */
export interface TopicQuery {
  workspace: null;
  agents: ApiAgentQuery;
  terminals: ApiScopeQuery;
  windows: ApiScopeQuery;
  events: ApiEventQuery;
  git: null;
  actions: null;
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
  /** The task, as a complete brief. */
  prompt: string;
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

// ── the elements ────────────────────────────────────────

export type ApiTone = "neutral" | "accent" | "success" | "warning" | "danger";

/**
 * A prop's type on the wire. A string array is an enum. "text" is a string or a
 * number; "numbers" a number[]; "menu" a MenuEntry[] whose `run`s are handlers;
 * "action" `{ label, run }`; "viewState" View's state; "options" a Segmented's.
 */
export type ApiPropType = "string" | "text" | "number" | "boolean" | "numbers" | "menu" | "action" | "viewState" | "options" | readonly (string | number)[];

export interface ApiElementSpec {
  props: Record<string, ApiPropType>;
  /** The handler props it takes ("onClick"); a handler anywhere else is dropped. */
  events: readonly string[];
  /** What it holds: nothing, strings only, elements only, or both. */
  children: "none" | "text" | "elements" | "any";
}

const SPACE = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12] as const;
const TONES = ["neutral", "accent", "success", "warning", "danger"] as const;
const LIGHTS = ["needs", "unseen", "working", "done", "idle", "off", ...TONES] as const;
const TEXT_SIZES = ["2xs", "xs", "sm", "md", "base", "lg", "xl", "display"] as const;
const ALIGN = ["start", "center", "end", "stretch", "baseline"] as const;
const BAR_TONES = ["accent", "danger", "needs"] as const;
const BREAKS = ["narrow", "regular"] as const;
const none = { props: {}, events: [], children: "none" } as const;
/** What every toolbar item takes: its place in the ⋯ menu when room runs out, faded until hovered. */
const ITEM = { priority: "number", secondary: "boolean" } as const;

/** API 1's elements, with each one's props and events: the allow-list the renderer enforces. */
export const API_ELEMENTS = {
  Window: { props: { status: "string", menu: "menu", actions: "menu" }, events: [], children: "elements" },
  View: { props: { inset: "boolean", scroll: "boolean", state: "viewState" }, events: [], children: "elements" },
  WindowToolbar: { props: { label: "string", bottom: "boolean" }, events: [], children: "elements" },
  ToolbarButton: { props: { label: "string", icon: "string", showLabel: "boolean", pressed: "boolean", disabled: "boolean", tone: BAR_TONES, badge: "text", tip: "string", ...ITEM }, events: ["onClick"], children: "none" },
  ToolbarField: { props: { value: "string", placeholder: "string", icon: "string", ...ITEM }, events: ["onChange", "onSubmit"], children: "none" },
  ToolbarSearchField: { props: { value: "string", placeholder: "string", count: "text", ...ITEM }, events: ["onChange"], children: "none" },
  ToolbarSegmented: { props: { value: "string", options: "options", label: "string", ...ITEM }, events: ["onChange"], children: "none" },
  ToolbarMenu: { props: { label: "string", icon: "string", menu: "menu", disabled: "boolean", ...ITEM }, events: [], children: "none" },
  ToolbarText: { props: { ...ITEM }, events: [], children: "text" },
  ToolbarSpacer: none,
  Stack: { props: { gap: SPACE, pad: [...SPACE, "inset"], padY: SPACE, align: ALIGN, grow: "boolean" }, events: [], children: "elements" },
  Inline: { props: { gap: SPACE, align: ALIGN, justify: ["start", "between", "end"], wrap: "boolean", grow: "boolean" }, events: [], children: "elements" },
  Tiles: { props: { min: [96, 120, 160, 200, 240, 320], gap: SPACE }, events: [], children: "elements" },
  Hide: { props: { below: BREAKS, above: BREAKS }, events: [], children: "elements" },
  List: { props: {}, events: [], children: "elements" },
  ListSection: { props: { title: "string", count: "number", open: "boolean", tone: ["needs", "danger"] }, events: ["onToggle"], children: "elements" },
  ListRow: { props: { selected: "boolean", dim: "boolean", depth: "number", tip: "string", menu: "menu" }, events: ["onClick", "onDoubleClick"], children: "elements" },
  ListRowIcon: { props: { icon: "string", light: LIGHTS, tone: [...LIGHTS, "dim"] }, events: [], children: "none" },
  ListRowContent: { props: { title: "text", place: "text", detail: "text", tone: ["needs", "danger"], mono: "boolean" }, events: [], children: "none" },
  ListRowEnd: { props: {}, events: [], children: "any" },
  Chip: { props: { hue: "number", tip: "string" }, events: [], children: "text" },
  Stat: { props: { label: "string", value: "text", unit: "string", delta: "text", deltaTone: TONES }, events: ["onSelect"], children: "none" },
  Sparkline: { props: { values: "numbers", height: "number", area: "boolean", color: ["current", "neutral"] }, events: [], children: "none" },
  Text: { props: { tone: ["dim", ...TONES], size: TEXT_SIZES, mono: "boolean", strong: "boolean", truncate: "boolean", select: "boolean", balance: "boolean" }, events: [], children: "text" },
  Badge: { props: { tone: TONES, size: ["sm", "md"], solid: "boolean", tip: "string" }, events: [], children: "text" },
  StatusDot: { props: { state: LIGHTS, size: ["sm", "md"], label: "string" }, events: [], children: "none" },
  Button: { props: { variant: ["default", "primary", "danger", "ghost"], size: ["sm", "md", "lg"], icon: "string", pressed: "boolean", busy: "boolean", disabled: "boolean" }, events: ["onClick"], children: "text" },
  EmptyState: { props: { icon: "string", title: "string", text: "string", action: "action", compact: "boolean" }, events: [], children: "none" },
  Callout: { props: { tone: TONES, title: "string", icon: "string", compact: "boolean", banner: "boolean" }, events: ["onDismiss"], children: "any" },
  Progress: { props: { value: "number", tone: TONES, label: "string" }, events: [], children: "none" },
} as const satisfies Record<string, ApiElementSpec>;

export type ApiElement = keyof typeof API_ELEMENTS;
export const API_ELEMENT_NAMES = Object.keys(API_ELEMENTS) as ApiElement[];

/** A menu entry in a prop (`Window menu`, `ListRow menu`): data, with `run` as a handler. */
export type WireMenuEntry = { label: string; run?: HandlerRef; checked?: boolean; disabled?: boolean; submenu?: WireMenuEntry[] } | { separator: true };

// ── remote ──────────────────────────────────────────────

const isHandlerRef = (v: WireValue): v is HandlerRef => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $handler?: unknown }).$handler === "number";

/** A prop value without handler refs: a ref goes, and so does a menu entry's or an action's `run` with it. */
function stripValue(v: WireValue): WireValue | undefined {
  if (isHandlerRef(v)) return undefined;
  if (Array.isArray(v)) return v.map(stripValue).filter((x): x is WireValue => x !== undefined);
  if (v && typeof v === "object") {
    const out: { [key: string]: WireValue } = {};
    for (const [k, x] of Object.entries(v)) {
      const s = stripValue(x);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return v;
}

function stripProps(props: Record<string, WireValue>): Record<string, WireValue> {
  const out: Record<string, WireValue> = {};
  for (const [k, v] of Object.entries(props)) {
    const s = stripValue(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function stripNode(n: TreeNode): TreeNode {
  return n.type === "#text" ? n : { ...n, props: stripProps(n.props), children: n.children.map(stripNode) };
}

/**
 * A widget's tree or patch as a view-scope device gets it (docs/56, "Remote"): no handler
 * refs anywhere, so nothing on it can be pressed. A props op's set loses its handlers and
 * unsets those props instead, so a handler sent before can't linger. Anything else passes.
 */
export function withoutHandlers<M extends WidgetTree | WidgetPatch | { kind: string }>(m: M): M {
  if (m.kind === "tree") {
    const t = m as unknown as WidgetTree;
    return { ...t, nodes: t.nodes.map(stripNode) } as unknown as M;
  }
  if (m.kind === "patch") {
    const p = m as unknown as WidgetPatch;
    const ops = p.ops.map((op): PatchOp => {
      if (op.op === "insert") return { ...op, node: stripNode(op.node) };
      if (op.op !== "props") return op;
      const set = stripProps(op.set);
      const gone = Object.keys(op.set).filter((k) => !(k in set));
      return { ...op, set, unset: [...op.unset, ...gone] };
    });
    return { ...p, ops } as unknown as M;
  }
  return m;
}

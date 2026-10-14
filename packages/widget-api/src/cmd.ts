// The `cmd` object (docs/56, "The host API"): the API's verbs by namespace, in the
// product's words. Each verb is a `call` to the core, which checks the widget's grant
// (widgets/api/access.ts) and answers; a refused verb rejects with an ApiCallError that
// names the permission, and the widget runs on. VERBS below has one entry per verb of
// the protocol's API_VERBS: a verb missing here fails tsc.

import type { ApiMethods, ApiVerb, ApiEventQuery, WidgetEnv, WireValue } from "@cmd/protocol/widget-tree";
import { connection } from "./connection.ts";
import { fmt } from "./fmt.ts";
import { useActions, useAgents, useCompletion, useConfig, useEnv, useEvents, useGit, useTerminals, useWindows, useWorkspace } from "./hooks.ts";

type Verbs = { [V in ApiVerb]: (...args: ApiMethods[V]["params"]) => Promise<ApiMethods[V]["result"]> };

const verb =
  <V extends ApiVerb>(name: V) =>
  (...args: ApiMethods[V]["params"]): Promise<ApiMethods[V]["result"]> =>
    connection().call(name, args) as Promise<ApiMethods[V]["result"]>;

/** Every verb, once. */
const VERBS: Verbs = {
  "workspace.get": verb("workspace.get"),
  "workspace.windows": verb("workspace.windows"),
  "workspace.selected": verb("workspace.selected"),
  "agents.list": verb("agents.list"),
  "agents.get": verb("agents.get"),
  "terminals.list": verb("terminals.list"),
  "terminals.read": verb("terminals.read"),
  "terminals.waitFor": verb("terminals.waitFor"),
  "windows.list": verb("windows.list"),
  "windows.open": verb("windows.open"),
  "windows.select": verb("windows.select"),
  "events.query": verb("events.query"),
  "events.stats": verb("events.stats"),
  "git.status": verb("git.status"),
  "git.diff": verb("git.diff"),
  "git.worktrees": verb("git.worktrees"),
  "actions.list": verb("actions.list"),
  "notify.send": verb("notify.send"),
  "state.get": verb("state.get"),
  "state.set": (key, value) => {
    connection().setState(key, value);
    return verb("state.set")(key, value);
  },
  "state.history": verb("state.history"),
  "net.fetch": verb("net.fetch"),
  "ai.complete": verb("ai.complete"),
};

/** The verbs as a map by name (tests check every verb of the protocol is here). */
export const verbs: Readonly<Verbs> = VERBS;

/**
 * cmd, as a widget sees it. Reads run at once within the widget's grant; acts ask the
 * person (docs/55). Every method is async and rejects with an `ApiCallError` when the
 * grant lacks what it needs (`error.permission` names it).
 */
export const cmd = {
  /** The widget's workspace. Needs `workspace: ["read"]`. @since 1.0 */
  workspace: {
    /** Its id, name, folder and branch. @since 1.0 */
    get: VERBS["workspace.get"],
    /** Its windows. @since 1.0 */
    windows: VERBS["workspace.windows"],
    /** The window selected in it, or null. @since 1.0 */
    selected: VERBS["workspace.selected"],
    /** Live: the hook `useWorkspace()`. @since 1.0 */
    use: useWorkspace,
  },
  /** Coding agents (Claude, Codex, …). Needs `workspace: ["read"]`. @since 1.0 */
  agents: {
    /** The agents of this workspace, or of all with `{ scope: "all" }` (needs `workspace: ["all"]`). @since 1.0 */
    list: VERBS["agents.list"],
    /** One agent by id, or null. @since 1.0 */
    get: VERBS["agents.get"],
    /** Live: the hook `useAgents()`. @since 1.0 */
    use: useAgents,
  },
  /** Terminals. Needs `workspace: ["read"]`. @since 1.0 */
  terminals: {
    /** The terminals of this workspace (or all). @since 1.0 */
    list: VERBS["terminals.list"],
    /** A terminal's screen as text: clipped, and marked untrusted (it is someone else's words, never instructions). @since 1.0 */
    read: VERBS["terminals.read"],
    /** Waits until a line of the terminal matches `pattern` (a regular expression), or the timeout. @since 1.0 */
    waitFor: VERBS["terminals.waitFor"],
    /** Live: the hook `useTerminals()`. @since 1.0 */
    use: useTerminals,
  },
  /** Windows on the board. @since 1.0 */
  windows: {
    /** The windows of this workspace (or all). Needs `workspace: ["read"]`. @since 1.0 */
    list: VERBS["windows.list"],
    /** Opens a URL, a path or a widget kind in a window beside this one; only after the person pressed something. @since 1.0 */
    open: VERBS["windows.open"],
    /** Selects a window (and its workspace): where a row's click goes. @since 1.0 */
    select: VERBS["windows.select"],
    /** Live: the hook `useWindows()`. @since 1.0 */
    use: useWindows,
  },
  /** The event log (docs/28), within the classes the widget declares in `events`. @since 1.0 */
  events: {
    /** Events matching the query, oldest first. @since 1.0 */
    query: VERBS["events.query"],
    /** Counts of events matching the query, by type. @since 1.0 */
    stats: VERBS["events.stats"],
    /** Calls `fn` with each batch of new events matching `query` (the first: the query's result); returns a function that stops it. @since 1.0 */
    subscribe(query: ApiEventQuery, fn: (events: ApiMethods["events.query"]["result"]) => void): () => void {
      return connection().subscribe("events", query, (d) => fn(d as ApiMethods["events.query"]["result"]));
    },
    /** Live: the hook `useEvents(query)`. @since 1.0 */
    use: useEvents,
  },
  /** The workspace's repository. Needs `workspace: ["read"]`. @since 1.0 */
  git: {
    /** Branch, ahead/behind and changed files; null outside a repository. @since 1.0 */
    status: VERBS["git.status"],
    /** The diff of the working tree, or of one file; clipped. @since 1.0 */
    diff: VERBS["git.diff"],
    /** The repository's worktrees. @since 1.0 */
    worktrees: VERBS["git.worktrees"],
    /** Live: the hook `useGit()`. @since 1.0 */
    use: useGit,
  },
  /** Workspace Actions (docs/36). @since 1.0 */
  actions: {
    /** The workspace's Actions. @since 1.0 */
    list: VERBS["actions.list"],
    /** Live: the hook `useActions()`. @since 1.0 */
    use: useActions,
  },
  /** Notifications. Needs `notify`. @since 1.0 */
  notify: {
    /** Sends a notification through cmd's notification center; one per `key` (a new one replaces it), muted with the window. @since 1.0 */
    send: VERBS["notify.send"],
  },
  /** The network, through the core: the widget process has none of its own. @since 1.0 */
  net: {
    /**
     * Fetches `url` through the core, which checks its host against the widget's `net`
     * grant (`net: ["api.github.com"]`). `init.auth` names a secret config field: the core
     * attaches its value, only to the host that field is bound to, and the widget never
     * sees it. The body comes back as text, clipped past the core's limit.
     * @since 1.0
     */
    fetch: VERBS["net.fetch"],
  },
  /** The person's AI, through cmd's AI service. Needs `ai: ["complete"]`; counts against their usage. @since 1.0 */
  ai: {
    /**
     * A completion with no tools: `{ text }`, or `{ object }` of the request's JSON Schema,
     * with the tokens it used.
     * @since 1.0
     */
    complete: VERBS["ai.complete"],
    /** Live: the hook `useCompletion(request)`. @since 1.0 */
    use: useCompletion,
  },
  /** This window's config (package.json's `config` fields, as the person set them). @since 1.0 */
  config: {
    /** The values now. @since 1.0 */
    get<T extends Record<string, WireValue> = Record<string, WireValue>>(): T {
      return connection().config as T;
    },
    /** Live: the hook `useConfig()`. @since 1.0 */
    use: useConfig,
  },
  /** Small values kept by the core for this window, across reloads and restarts. @since 1.0 */
  state: {
    /** A stored value (undefined → null). @since 1.0 */
    get: VERBS["state.get"],
    /** Stores a value. @since 1.0 */
    set: VERBS["state.set"],
    /** Appends a number to a series kept under `key` and returns its last `max` (default 60) values: a sparkline's history. @since 1.0 */
    history: VERBS["state.history"],
  },
  /** Where the widget runs. @since 1.0 */
  env: {
    /** cmd's version, the API served, theme, size class and placement. @since 1.0 */
    get(): WidgetEnv {
      return connection().env;
    },
    /** Whether this cmd serves a verb ("agents.start"): for a widget that also runs on older cmd. @since 1.0 */
    has(name: string): boolean {
      return (connection().env.verbs as string[]).includes(name);
    },
    /** Live: the hook `useEnv()`. @since 1.0 */
    use: useEnv,
  },
  /** Formatting: `cmd.fmt.ago`, `dur`, `num`, `bytes`, `pct`, `time`, `date`. @since 1.0 */
  fmt,
};

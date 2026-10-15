// The `cmd` object (docs/56, "The host API"): the API's verbs by namespace, in the
// product's words. Each verb is a `call` to the core, which checks the widget's grant
// (widgets/api/access.ts) and answers; a refused verb rejects with an ApiCallError that
// names the permission, and the widget runs on. VERBS below has one entry per verb of
// the protocol's API_VERBS: a verb missing here fails tsc. The JSDoc's @since and "Needs"
// are the verb's API row (protocol widget-verbs.ts): test/contract.test.ts holds them to it.

import type { ApiMethods, ApiVerb, ApiEventQuery, ApiRunOptions, ApiRunResult, WidgetEnv, WireValue } from "@cmd/protocol/widget-tree";
import { connection } from "./connection.ts";
import { ELEMENT_SINCE } from "./elements-since.gen.ts";
import { fmt } from "./fmt.ts";
import { useActions, useAgents, useCompletion, useConfig, useEnv, useEvents, useGit, useStorage, useTerminals, useWindows, useWorkspace } from "./hooks.ts";
import { registerMigration, store } from "./storage.ts";

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
  "agents.start": verb("agents.start"),
  "agents.send": verb("agents.send"),
  "agents.stop": verb("agents.stop"),
  "terminals.type": verb("terminals.type"),
  "terminals.open": verb("terminals.open"),
  "actions.run": verb("actions.run"),
  "windows.close": verb("windows.close"),
  "run.exec": verb("run.exec"),
  "actions.stop": verb("actions.stop"),
  "events.classes": verb("events.classes"),
  "terminals.usage": verb("terminals.usage"),
  "stats.query": verb("stats.query"),
  "journal.days": verb("journal.days"),
  "media.get": verb("media.get"),
  "media.control": verb("media.control"),
  "clipboard.write": verb("clipboard.write"),
  "storage.get": verb("storage.get"),
  "storage.set": (scope, key, value) => {
    if (scope === "window") connection().setState(key, value ?? null);
    return verb("storage.set")(scope, key, value ?? null);
  },
  "storage.delete": (scope, key) => {
    if (scope === "window") connection().setState(key, null);
    return verb("storage.delete")(scope, key);
  },
  "storage.keys": verb("storage.keys"),
  "storage.history": verb("storage.history"),
};

/** cmd.run: a function (`cmd.run("gh", ["run", "list"])`) that is also the namespace of its one verb (`cmd.run.exec`). */
interface Run {
  /**
   * Runs a program the widget declares in `run` (`run: ["gh"]`) through the core, never a
   * shell: `args` reach it as they are. Only read-only commands run (the same rules as
   * Magic's: `gh run list` yes, `gh run rerun` or `git -c alias.x=…` no; a refusal says
   * why). At most 10 s by default (`timeoutMs`, up to 30 s), 64 KB of stdout and 16 KB of
   * stderr (more is cut, `clipped`), 2 at once and 30 a minute; tokens in the output are
   * blanked. Its folder is the workspace's unless `cwd` names another in it or in `read`.
   * @since 1.1
   */
  (program: string, args?: string[], opts?: ApiRunOptions): Promise<ApiRunResult>;
  /** The same as calling `cmd.run`: the verb's name on the wire. @since 1.1 */
  exec: (program: string, args?: string[], opts?: ApiRunOptions) => Promise<ApiRunResult>;
}

const run: Run = Object.assign((program: string, args?: string[], opts?: ApiRunOptions) => VERBS["run.exec"](program, args, opts), { exec: VERBS["run.exec"] });

/** The verbs as a map by name (tests check every verb of the protocol is here). */
export const verbs: Readonly<Verbs> = VERBS;

/**
 * cmd, as a widget sees it. Reads run at once within the widget's grant; acts (1.1) ask the
 * person (docs/55), only right after they pressed something in the widget, and only in its
 * own workspace. Every method is async and rejects with an `ApiCallError` when the grant
 * lacks what it needs (`error.permission` names it) or the person says no (`code: "denied"`).
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
    /**
     * Starts a coding agent on a task, in a terminal of its own in this workspace. The prompt
     * is typed text: it asks every time, showing the prompt, and is never kept for always.
     * Works only right after they pressed something in the widget, once per press. Needs
     * `act: ["agents"]` (or `"agents.start"`).
     * @since 1.1
     */
    start: VERBS["agents.start"],
    /**
     * Sends a message to an agent of this workspace, as if typed into its terminal. Typed
     * text always asks, every time. Needs `act: ["agents"]` (or `"agents.send"`); only after a press.
     * @since 1.1
     */
    send: VERBS["agents.send"],
    /** Stops an agent of this workspace. Asks first; only after a press. Needs `act: ["agents"]` (or `"agents.stop"`). @since 1.1 */
    stop: VERBS["agents.stop"],
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
    /**
     * Types `text` into a terminal of this workspace, and presses Return only with
     * `{ submit: true }`. Typed text always asks, every time, showing exactly what; some
     * commands are refused outright (root, piping a download into a shell, credentials).
     * Only after a press. Needs `act: ["terminals"]` (or `"terminals.type"`).
     * @since 1.1
     */
    type: VERBS["terminals.type"],
    /**
     * Opens a terminal in this workspace, in `cwd`, with `command` typed at its prompt but
     * not run: the person reads it and presses Return. Asks first; only after a press.
     * Needs `act: ["terminals"]` (or `"terminals.open"`).
     * @since 1.1
     */
    open: VERBS["terminals.open"],
    /**
     * What each terminal of this workspace uses now (or of every workspace with `{ scope: "all" }`,
     * which needs `workspace: ["all"]`): CPU (percent of one core), memory and processes of its
     * whole process tree, sampled every few seconds; a terminal not sampled yet isn't listed.
     * cmd's own processes aren't terminals and aren't here. Live: the hook `useTerminalUsage()`.
     * @since 1.2
     */
    usage: VERBS["terminals.usage"],
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
    /**
     * Closes a window of this workspace, never the widget's own. Asks first (a terminal's
     * command or agent ends with it); only after a press. Needs `act: ["windows"]` (or `"windows.close"`).
     * @since 1.1
     */
    close: VERBS["windows.close"],
    /** Live: the hook `useWindows()`. @since 1.0 */
    use: useWindows,
  },
  /** The event log (docs/28), within the classes the widget declares in `events`. @since 1.0 */
  events: {
    /** Events matching the query, oldest first. @since 1.0 */
    query: VERBS["events.query"],
    /** Counts of events matching the query, by type. @since 1.0 */
    stats: VERBS["events.stats"],
    /**
     * The log's classes a widget may name in `events`, as Settings → Data names them: each
     * class, its title and the event types it holds ("agent." takes every agent event). It says
     * what exists, not what happened, so it needs no permission.
     * @since 1.2
     */
    classes: VERBS["events.classes"],
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
    /**
     * Runs a Workspace Action by name in a terminal of its own. Asks first; only after a
     * press. A risky one (a deploy, a publish) is refused: the person runs those from
     * Workspace Actions. With `{ restart: true }` (1.2) one that is running is stopped and run
     * again in its terminal, one act. Needs `act: ["actions"]` (or `"actions.run"`).
     * @since 1.1
     */
    run: VERBS["actions.run"],
    /**
     * Stops a running Workspace Action of this workspace (⌃C in its terminal), whoever started
     * it. Asks first; only after a press. Needs `act: ["actions"]` (or `"actions.stop"`).
     * @since 1.2
     */
    stop: VERBS["actions.stop"],
    /** Live: the hook `useActions()`. @since 1.0 */
    use: useActions,
  },
  /** Stats (docs/49): how cmd is used, counted from the event log, as the Stats window shows them. @since 1.2 */
  stats: {
    /**
     * One stat over a range, by bucket: `{ stat: "agents.time", range: "7d" }`, split with `by`,
     * compared with the range before (`compare`) or ranked (`top`). This workspace's unless
     * `{ scope: "all" }` (with `workspace: ["all"]`); a stat that can't tell workspaces apart
     * needs "all". Needs `events: [<class>]` for the class it is counted from (an error names it).
     * @since 1.2
     */
    query: VERBS["stats.query"],
  },
  /** The journal (docs/23): what happened in this workspace, a few lines a day. @since 1.2 */
  journal: {
    /**
     * The last `count` work days of this workspace with something in them (default 7, at most
     * 30), newest first, as the Journal has written them; a day not written yet isn't there (a
     * widget never has one written). Needs `workspace: ["read"]` and `events: ["agents"]`
     * (a day is written from the agents' prompts and work).
     * @since 1.2
     */
    days: VERBS["journal.days"],
  },
  /** What the Mac is playing (any app that tells macOS: Music, Spotify, a browser tab). @since 1.2 */
  media: {
    /** The track, its app, position and cover, or null when nothing plays. Needs `media: ["read"]`. @since 1.2 */
    get: VERBS["media.get"],
    /**
     * Play or pause (`"toggle"`), `"next"`, `"previous"`, 15 seconds `"back15"` or `"forward15"`,
     * or `(null, { seek })` to a position in seconds. Only right after a press in the widget on
     * this Mac (never from a paired device), once per press. Needs `media: ["control"]`.
     * @since 1.2
     */
    control: VERBS["media.control"],
  },
  /** The Mac's clipboard. @since 1.2 */
  clipboard: {
    /**
     * Puts text on the clipboard: Copy. Only right after a press in the widget on this Mac
     * (never from a paired device), once per press; text past 64 KB is cut. Needs no permission.
     * @since 1.2
     */
    write: VERBS["clipboard.write"],
  },
  /** Notifications. They need no permission. @since 1.0 */
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
  /** Programs, through the core: `cmd.run("gh", ["run", "list"])`. Needs `run: [<program>]`. @since 1.1 */
  run,
  /** This window's config (package.json's `config` fields, as the person set them). @since 1.0 */
  config: {
    /** The values now. @since 1.0 */
    get<T extends Record<string, WireValue> = Record<string, WireValue>>(): T {
      return connection().config as T;
    },
    /** Live: the hook `useConfig()`. @since 1.0 */
    use: useConfig,
  },
  /**
   * JSON values kept by cmd across reloads, restarts and updates, in three scopes: `window` (this
   * window, 256 KB; the same data as `cmd.state`), `workspace` (this package in the window's
   * workspace, shared by its windows there, 10 MB) and `package` (this package in every window and
   * workspace, 10 MB). Each value is at most 1 MB, each key 1 to 200 characters. A package sees
   * only its own; uninstalling it deletes its data, an update keeps it, deleting a workspace
   * deletes that workspace's. Needs no permission. Live: the hook `useStorage(scope, key, initial)`.
   * @since 1.3
   */
  storage: {
    /** This window's values: what `cmd.state` keeps, gone with the window. @since 1.3 */
    window: store("window"),
    /** This package's values in the window's workspace, shared by its windows there. @since 1.3 */
    workspace: store("workspace"),
    /** This package's values everywhere: every window, every workspace (a notes widget's notes). @since 1.3 */
    package: store("package"),
    /**
     * Registers the migration that reshapes stored data when package.json's `cmd.storage.version`
     * goes up: `cmd.storage.migrate(async ({ scope, from, to }) => { … })`, at the top of the
     * widget's module. Each place keeps its own version: the package's data, each workspace's, each
     * window's. When a window starts, each of its places that is behind runs it once, in order
     * package, workspace, window, with `scope` naming the store to reshape (only it can be written;
     * a place with no data starts at the new version, no migration). If it throws, that place keeps
     * its data and version (places migrated before it stay migrated) and the window says why.
     * @since 1.3
     */
    migrate: registerMigration,
    /** A value of a scope: `cmd.storage.get("package", key)` is `cmd.storage.package.get(key)`. @since 1.3 */
    get: VERBS["storage.get"],
    /** Keeps a value in a scope; null deletes it. @since 1.3 */
    set: VERBS["storage.set"],
    /** Deletes a value of a scope. @since 1.3 */
    delete: VERBS["storage.delete"],
    /** A scope's keys, sorted, those starting with `prefix` only. @since 1.3 */
    keys: VERBS["storage.keys"],
    /** Appends a number to a scope's series under `key` and returns its last `max` values. @since 1.3 */
    history: VERBS["storage.history"],
    /** Live: the hook `useStorage(scope, key, initial)`. @since 1.3 */
    use: useStorage,
  },
  /** Small values kept by the core for this window, across reloads and restarts: `cmd.storage.window` under its first name. @since 1.0 */
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
    /**
     * Whether this cmd serves a verb ("agents.start", added in 1.1) or draws an element ("DataGrid",
     * added in 1.2): for a widget that also runs on an older cmd. @since 1.0
     */
    has(name: string): boolean {
      const env = connection().env;
      if ((env.verbs as string[]).includes(name)) return true;
      // A cmd before 1.2 doesn't list its elements: it draws those of its minor and before.
      if (env.elements) return (env.elements as string[]).includes(name);
      const since = ELEMENT_SINCE[name];
      return !!since && Number(since.split(".")[1]) <= env.api.minor;
    },
    /** Live: the hook `useEnv()`. @since 1.0 */
    use: useEnv,
  },
  /** Formatting: `cmd.fmt.ago`, `dur`, `num`, `bytes`, `pct`, `time`, `date`. @since 1.0 */
  fmt,
};

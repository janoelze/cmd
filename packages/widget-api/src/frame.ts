// `@cmd/widget-api/frame`: the `cmd` a frame widget's page has (docs/56, "The frame surface"),
// for authors of a `view.html` (`"surface": "frame"`). It is the widget process's `cmd` (cmd.ts),
// every verb under the same name and with the same grant, minus what needs React (the hooks,
// `use()`) and plus what a page needs: a live topic is `cmd.<topic>.subscribe(query, fn)` or
// `cmd.on(topic, fn, query)`, the window's state and config are at hand synchronously, and
// `cmd.open` opens a window. Everything is derived from the process's `cmd` and the protocol's
// registry (widget-verbs.ts), so a verb added there is here; the page's runtime
// (apps/desktop/src/package-frame/frame.js) builds its `cmd` from the same registry. Types only.
//
//   /// <reference types="@cmd/widget-api/frame" />
//   const agents = await cmd.agents.list();
//   cmd.agents.subscribe((list) => draw(list));
//   button.onclick = () => cmd.windows.open("https://example.com/");

import type { API_TOPIC, ApiError, ApiMethods, ApiStorageQuery, ApiTopic, WidgetEnv, WireValue } from "@cmd/protocol/widget-tree";
import type { Store } from "./storage.ts";
import type { cmd as ProcessCmd } from "./cmd.ts";

type Process = typeof ProcessCmd;

/** A refused or failed call (as `ApiCallError` in a widget's process): `code` says why, `permission` what to add to package.json. */
export interface FrameCallError extends Error {
  readonly name: "ApiCallError";
  readonly code: ApiError["code"];
  readonly permission: string | undefined;
}

/** What a live topic sends: the value of the read it is the live form of (`agents`: what `cmd.agents.list()` returns). */
export type TopicValue<T extends ApiTopic> = ApiMethods[(typeof API_TOPIC)[T]["verb"]]["result"];
/** What a live topic takes: its read's query (`{ scope: "all" }`, or an event query). */
export type TopicQuery<T extends ApiTopic> = T extends "storage" ? ApiStorageQuery : NonNullable<ApiMethods[(typeof API_TOPIC)[T]["verb"]]["params"][0]>;

/** A namespace's live topic, as a page subscribes to it. */
export interface Live<T extends ApiTopic> {
  /**
   * Calls `fn` with the topic's value now and again on each change (for `events`: the query's
   * result, then each batch of new events); returns a function that stops it. When the widget
   * restarts it goes on, starting again with the value then. A refusal (the grant doesn't reach
   * it) or its end (the widget stopped) goes to `onError`, else the console.
   * @since 1.1
   */
  subscribe(fn: (value: TopicValue<T>) => void): () => void;
  subscribe(query: TopicQuery<T> | null, fn: (value: TopicValue<T>) => void, onError?: (e: FrameCallError) => void): () => void;
}

/** What a frame's `cmd` leaves out of a namespace, or holds differently: the hooks, and the process's own subscribe. */
type Omitted = "fmt" | "config" | "env" | "state" | "run";

/** One scope of a page's storage: the process's Store, and its keys live. @since 1.3 */
export interface FrameStore extends Store {
  /** Calls `fn` with the key's value now and on each change, from any window of the package (null: none); returns what stops it. @since 1.3 */
  subscribe(key: string, fn: (value: WireValue | null) => void, onError?: (e: FrameCallError) => void): () => void;
}

/** A page's `cmd.storage`: the process's (but `migrate`, which its process registers), each scope's keys live. @since 1.3 */
export type FrameStorage = Omit<Process["storage"], "use" | "migrate" | "window" | "workspace" | "package"> & Live<"storage"> & { window: FrameStore; workspace: FrameStore; package: FrameStore };

/** The namespaces of verbs: the process's, without the hooks, each live one with `subscribe`. */
export type FrameNamespaces = {
  [N in keyof Process as N extends Omitted ? never : N]: N extends "storage" ? FrameStorage : Omit<Process[N], "use" | "subscribe"> & (N extends ApiTopic ? Live<N> : unknown);
};

/** Live topics that aren't a namespace of verbs (1.2's `terminalUsage`, the live `cmd.terminals.usage`): `cmd.terminalUsage.subscribe(fn)`. */
export type FrameTopics = { [T in Exclude<ApiTopic, keyof Process>]: Live<T> };

/** The `cmd` of a frame widget's page. Everything is async but `state.get`, `state.all`, `config`, `theme` and `env`. */
export type FrameCmd = FrameNamespaces & FrameTopics & {
  /** Programs, through the core: `cmd.run("gh", ["run", "list"])`. Needs `run: [<program>]`. @since 1.1 */
  run: Process["run"];
  /** Small values kept by the core for this window, shared with the widget's process. */
  state: {
    /** A stored value, at once (null when none). */
    get(key: string): WireValue | null;
    /** Stores a value (null removes it); sent a moment later, with others set meanwhile. */
    set(key: string, value: WireValue | null): Promise<null>;
    /** Every stored value. */
    all(): Record<string, WireValue>;
    /** Appends a number to a series kept under `key` and returns its last `max` (default 60) values. */
    history: Process["state"]["history"];
  };
  /** This window's config values (package.json's `config` fields, as the person set them; never a secret); `cmd.config.get()` too. */
  readonly config: Record<string, WireValue> & { get(): Record<string, WireValue> };
  /** "dark" or "light". The theme's variables are on :root: `var(--text)`, `var(--accent)`, `var(--space-2)`… */
  readonly theme: "dark" | "light";
  /** A Frame element's `data`, as the widget's process passes it (null in a frame widget's page). @since 1.2 */
  readonly data: WireValue | null;
  /** Sends a value to the widget's process: the Frame element's `onMessage`. Plain data, 256 KB at most; not a press, so it can't start an act. @since 1.2 */
  post(value: WireValue): void;
  /** Where the page runs. */
  env: {
    /** cmd's version, the API served and its verbs, the theme, the size class and placement. */
    get(): WidgetEnv;
    /** Whether this cmd serves a verb ("agents.start"). */
    has(name: string): boolean;
  };
  /**
   * `fn` when the window's `"state"`, `"config"` or `"theme"` changes, a Frame's `"data"`, or on each change of a
   * live topic (`"agents"`, `"events"` with `query`…, as `cmd.<topic>.subscribe`); returns what stops it.
   */
  on(type: "state" | "config", fn: (value: Record<string, WireValue>) => void): () => void;
  on(type: "theme", fn: (value: "dark" | "light") => void): () => void;
  on(type: "data", fn: (value: WireValue | null) => void): () => void;
  on<T extends ApiTopic>(type: T, fn: (value: TopicValue<T>) => void, query?: TopicQuery<T>): () => void;
  /** Opens a URL, a path or a widget in a window beside this one: `cmd.windows.open`. Only right after a click in the frame. */
  open(target: string): Promise<{ id: string }>;
  /** The class of a refused call's error. */
  ApiCallError: new (e: ApiError) => FrameCallError;
};

declare global {
  /** cmd, as a frame widget's page has it (`@cmd/widget-api/frame`). */
  var cmd: FrameCmd;
}

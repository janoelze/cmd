// The hooks (docs/56, "Writing the UI"): the API's reads as subscriptions. Each live hook
// subscribes on mount, gets the current value at once and every change after, and
// unsubscribes on unmount: a widget never polls cmd for what cmd can push. useData is for
// the outside world (`cmd.net.fetch`) on a timer, with the health the title bar shows;
// useCompletion asks the person's AI (`cmd.ai.complete`) once per request.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ApiAppUsage, ApiJournalDay, ApiJournalQuery, ApiStatQuery, ApiStatResult, ApiWorkspaceName, ApiStorageScope, ApiCompletion, ApiCompletionRequest, ApiAction, ApiTerminalUsage, ApiUsageQuery, ApiAgent, ApiAgentQuery, ApiEvent, ApiEventQuery, ApiGitStatus, ApiScopeQuery, ApiTerminal, ApiTopic, ApiWindow, ApiWorkspace, TopicData, TopicQuery, WidgetEnv, WireValue } from "@cmd/protocol/widget-tree";
import { mergeEvents } from "@cmd/protocol/widget-events";
import { connection, type ApiCallError } from "./connection.ts";

/** A topic's current value, live; `initial` until the core's first event. */
function useTopic<T extends ApiTopic>(topic: T, query: TopicQuery[T] | null, initial: TopicData[T], merge?: (prev: TopicData[T], next: TopicData[T]) => TopicData[T]): TopicData[T] {
  const [value, setValue] = useState(initial);
  // A refusal (the grant lacks what the topic needs) is thrown on render: the reconciler's boundary shows it.
  const [refused, setRefused] = useState<ApiCallError | null>(null);
  const key = JSON.stringify(query ?? null);
  const mergeRef = useRef(merge);
  mergeRef.current = merge;
  const lastKey = useRef(key);
  useEffect(() => {
    // A new query starts from nothing, not from the last query's data.
    if (lastKey.current !== key) setValue(initial);
    lastKey.current = key;
    setRefused(null);
    return connection().subscribe(topic, query, (data) => setValue((prev) => (mergeRef.current ? mergeRef.current(prev, data as TopicData[T]) : (data as TopicData[T]))), setRefused);
    // The query by value: a new object with the same fields is the same subscription.
  }, [topic, key]);
  if (refused) throw refused;
  return value;
}

/**
 * The widget's workspace (id, name, folder, branch), live; null until it arrives.
 * Needs `workspace: ["read"]`.
 * @since 1.0
 */
export function useWorkspace(): ApiWorkspace | null {
  return useTopic("workspace", null, null as unknown as ApiWorkspace);
}

/**
 * The agents of this workspace (or every workspace with `{ scope: "all" }`), live: a
 * row updates when an agent's state, name or line changes. Empty until they arrive.
 * Needs `workspace: ["read"]` (`["all"]` for every workspace).
 * @since 1.0
 */
export function useAgents(query: ApiAgentQuery = {}): ApiAgent[] {
  return useTopic("agents", query, []);
}

/**
 * The terminals of this workspace (or all), live.
 * @since 1.0
 */
export function useTerminals(query: ApiScopeQuery = {}): ApiTerminal[] {
  return useTopic("terminals", query, []);
}

/**
 * What each terminal of this workspace (or all, with `{ scope: "all" }` and `workspace: ["all"]`)
 * uses, live: CPU, memory and processes of its process tree, a new sample every few seconds
 * when it moved. Empty until the first arrives. Needs `workspace: ["read"]`.
 * @since 1.2
 */
export function useTerminalUsage(query: ApiUsageQuery = {}): ApiTerminalUsage[] {
  return useTopic("terminalUsage", query, []);
}

/**
 * The windows of this workspace (or all), live, with which is selected.
 * @since 1.0
 */
export function useWindows(query: ApiScopeQuery = {}): ApiWindow[] {
  return useTopic("windows", query, []);
}

/**
 * Events from the log matching `query`, newest last: the query's result first, then each
 * new one as it happens; at most `query.limit` (default 200) are kept. An event recorded again
 * (a command as it ends: the same `key`, since 1.1) replaces the one before. Needs
 * `events: [<class>]` for each class of events it reads. `{ scope: "all" }` reads every
 * workspace's, with `workspace: ["all"]` (live since cmd of 2026-10-15; an older cmd refuses
 * it, and `cmd.events.query` reads them).
 * @since 1.0
 */
export function useEvents(query: ApiEventQuery = {}): ApiEvent[] {
  const limit = query.limit ?? 200;
  // The last of each key wins, within the new ones too (a command's start and end in one burst).
  return useTopic("events", query, [], (prev, next) => mergeEvents(prev, next).slice(-limit));
}

/**
 * The workspace's git status (branch, ahead/behind, changed files), live; null outside a repository.
 * @since 1.0
 */
export function useGit(): ApiGitStatus | null {
  return useTopic("git", null, null);
}

/**
 * The workspace's Actions (docs/36), live.
 * @since 1.0
 */
export function useActions(): ApiAction[] {
  return useTopic("actions", null, []);
}

/**
 * A stat, live: what `cmd.stats.query(query)` answers, counted again soon after cmd records
 * something for it (and each minute for time spent, which grows without events). null until it
 * arrives. Needs `events: [<class>]` for the class the stat is counted from.
 * @since 1.3
 */
export function useStat(query: ApiStatQuery): ApiStatResult | null {
  return useTopic("stats", query, null as unknown as ApiStatResult);
}

/**
 * The journal's written days, live: what `cmd.journal.days(query)` answers, again when the
 * Journal writes a day of it. Empty until they arrive. `{ scope: "all" }` reads the journal of
 * everything on this Mac (with `workspace: ["all"]`). Needs `workspace: ["read"]` and
 * `events: ["agents"]`.
 * @since 1.3
 */
export function useJournal(query: ApiJournalQuery = {}): ApiJournalDay[] {
  return useTopic("journal", query, []);
}

/**
 * Every workspace by id and name, live, in the switcher's order: what says where an agent or
 * terminal of another workspace is. Never their folders. Empty until they arrive. Needs
 * `workspace: ["all"]`.
 * @since 1.3
 */
export function useWorkspaces(): ApiWorkspaceName[] {
  return useTopic("workspaces", null, []);
}

/**
 * What cmd itself uses, live: the app's processes and the background one, CPU and memory,
 * sampled every 2 seconds while the widget shows it. null until the first sample. Needs
 * `events: ["system"]`.
 * @since 1.3
 */
export function useAppUsage(): ApiAppUsage | null {
  return useTopic("appUsage", null, null as unknown as ApiAppUsage);
}

function usePushed<T>(read: () => T): T {
  const c = connection();
  return useSyncExternalStore((fn) => c.watch(fn), read, read);
}

/**
 * A package's config, by field: empty here, filled in by the `cmd-env.d.ts` that `cmd widget
 * check` and `dev` write from package.json's `config` fields, so `useConfig()` is typed by
 * them and a renamed field is a type error.
 * @since 1.0
 */
export interface WidgetConfig {}

/** What `useConfig()` returns without a type: the package's `WidgetConfig`, else any values. @since 1.0 */
export type ConfigValues = keyof WidgetConfig extends never ? Record<string, WireValue> : WidgetConfig;

/** A config shape: each value one the wire carries. @since 1.0 */
export type ConfigShape<T> = { [K in keyof T]: WireValue };

/**
 * This window's config values (from package.json's `config` fields, as the person set
 * them, else their defaults), live, typed by `cmd-env.d.ts`. Secret fields are never here:
 * a widget never holds a secret (`cmd.net.fetch`'s `auth` names one).
 * @since 1.0
 */
export function useConfig<T extends ConfigShape<T> = ConfigValues>(): T {
  return usePushed(() => connection().config as T);
}

/**
 * Where the widget runs: cmd's version, the API served, the theme, the size class and
 * the placement (board or sidebar), live.
 * @since 1.0
 */
export function useEnv(): WidgetEnv {
  return usePushed(() => connection().env);
}

/**
 * A value kept by the core for this window across reloads and restarts, like useState.
 * The first render already has the stored value.
 * @since 1.0
 */
export function useStoredState<T extends WireValue = never, I extends WireValue = never>(key: string, initial: [T] extends [never] ? I : NoInfer<T>): Stored<StoredValue<T, I>> {
  return storedState(key, initial as WireValue) as unknown as Stored<StoredValue<T, I>>;
}

/**
 * A literal's type, widened: `0` is a number, `"all"` a string, `true` a boolean, `[]` a list of
 * any value; anything else as it is. What `useStorage` and `useStoredState` keep when their
 * value's type isn't given (`useStorage("package", "count", 0)` keeps a number).
 * @since 1.3
 */
export type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T extends readonly (infer E)[] ? ([E] extends [never] ? WireValue[] : Widen<E>[]) : T;

/** The value a stored-state hook keeps: the type given (`useStorage<Show>(…)`), else its initial value's, widened. @since 1.3 */
export type StoredValue<T, I> = [T] extends [never] ? Widen<I> : T;

/** What `useStoredState` and `useStorage` return: the value, and what sets it (a value, or a function of the last). @since 1.3 */
export type Stored<T> = [T, (next: T | ((prev: T) => T)) => void];

function storedState<T extends WireValue>(key: string, initial: T): Stored<T> {
  const c = connection();
  // The first initial, so a literal ({}) each render reads as the same value.
  const init = useRef(initial).current;
  const value = usePushed(() => (c.state.has(key) ? (c.state.get(key) as T) : init));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = (c.state.has(key) ? c.state.get(key) : init) as T;
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      c.setState(key, v);
      void c.call("state.set", [key, v]).catch(() => {});
    },
    [c, key, init],
  );
  return [value, set];
}

/**
 * A stored value, live, like useState: `useStorage("package", "notes", [])`. `scope` is
 * `"window"` (this window; `useStoredState` keeps the same values), `"workspace"` (this package
 * in the window's workspace) or `"package"` (this package everywhere). A set here reaches every
 * other open window of the package that uses the same scope and key at once. `initial` until the
 * stored value arrives (a window's own is there on the first render) and while none is stored.
 * @since 1.3
 */
export function useStorage<T extends WireValue = never, I extends WireValue = never>(scope: ApiStorageScope, key: string, initial: [T] extends [never] ? I : NoInfer<T>): Stored<StoredValue<T, I>> {
  return storage(scope, key, initial as WireValue) as unknown as Stored<StoredValue<T, I>>;
}

function storage<T extends WireValue>(scope: ApiStorageScope, key: string, initial: T): Stored<T> {
  const c = connection();
  const init = useRef(initial).current;
  const first = (): T => (scope === "window" && c.state.has(key) ? (c.state.get(key) as T) : init);
  const [value, setValue] = useState<T>(first);
  const current = useRef(value);
  current.current = value;
  const [refused, setRefused] = useState<ApiCallError | null>(null);
  const lastKey = useRef(`${scope}\n${key}`);
  useEffect(() => {
    // Another key starts from what is known of it, not from the last key's value.
    if (lastKey.current !== `${scope}\n${key}`) setValue(first());
    lastKey.current = `${scope}\n${key}`;
    setRefused(null);
    return c.subscribe("storage", { scope, key }, (data) => setValue(data === null ? init : (data as T)), setRefused);
  }, [c, scope, key]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const v = typeof next === "function" ? (next as (p: T) => T)(current.current) : next;
      current.current = v;
      setValue(v);
      if (scope === "window") c.setState(key, v);
      // A refusal (a full scope, a value too big) is the widget's log line; the value stays here until the next.
      void c.call("storage.set", [scope, key, v]).catch((e: ApiCallError) => console.error(`useStorage("${scope}", "${key}"): ${e.message}`));
    },
    [c, scope, key],
  );
  if (refused) throw refused;
  return [value, set];
}

/**
 * The time now, re-rendering every `every` ms (default 1000): for ages that move.
 * @since 1.0
 */
export function useNow(every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

/** What useData returns. @since 1.0 */
export interface DataState<T> {
  /** The last good result (kept on screen through errors), undefined before the first. */
  data: T | undefined;
  /** The last run's error, cleared by a good one. */
  error: Error | null;
  /** The data is from before the last failed run. */
  stale: boolean;
  /** A run is in flight. */
  refreshing: boolean;
  /** Run now. */
  refresh: () => void;
}

/**
 * The outside world on a timer: runs `fn` (a `cmd.net.fetch`) now and every `every`
 * seconds (default 60), keeps the last good data through failures and says how fresh it
 * is. A run that throws keeps the old data with `stale` and `error` set.
 * @since 1.0
 */
export function useData<T>(fn: () => Promise<T>, opts: { every?: number } = {}): DataState<T> {
  const every = opts.every ?? 60;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [state, setState] = useState<Omit<DataState<T>, "refresh">>({ data: undefined, error: null, stale: false, refreshing: true });
  const alive = useRef(true);
  const run = useCallback(() => {
    setState((s) => ({ ...s, refreshing: true }));
    fnRef.current().then(
      (data) => alive.current && setState({ data, error: null, stale: false, refreshing: false }),
      (e: unknown) => alive.current && setState((s) => ({ data: s.data, error: e instanceof Error ? e : new Error(String(e)), stale: s.data !== undefined, refreshing: false })),
    );
  }, []);
  useEffect(() => {
    alive.current = true;
    run();
    const t = every > 0 ? setInterval(run, every * 1000) : null;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [every, run]);
  return { ...state, refresh: run };
}

/** What useCompletion returns. @since 1.0 */
export interface CompletionState {
  /** The answer, undefined until it comes (and while a new request runs). */
  data: ApiCompletion | undefined;
  /** Why it failed (no `ai` grant, the AI service unset or over budget). */
  error: Error | null;
  /** A request is in flight. */
  loading: boolean;
  /** Asks again. */
  refresh: () => void;
}

/**
 * Asks the person's AI once per distinct `request` (a new prompt asks again; null asks
 * nothing): `cmd.ai.complete` as a hook. Needs `ai: ["complete"]`.
 * @since 1.0
 */
export function useCompletion(request: ApiCompletionRequest | null): CompletionState {
  const key = request ? JSON.stringify(request) : null;
  const [state, setState] = useState<Omit<CompletionState, "refresh">>({ data: undefined, error: null, loading: !!request });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!key) return void setState({ data: undefined, error: null, loading: false });
    let live = true;
    setState({ data: undefined, error: null, loading: true });
    connection()
      .call("ai.complete", [JSON.parse(key) as ApiCompletionRequest])
      .then(
        (data) => live && setState({ data: data as ApiCompletion, error: null, loading: false }),
        (e: unknown) => live && setState({ data: undefined, error: e instanceof Error ? e : new Error(String(e)), loading: false }),
      );
    return () => {
      live = false;
    };
  }, [key, nonce]);
  return { ...state, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}

// A fake core for widget tests: `createHost({ agents, … })` answers the process's hello,
// serves the reads from the data it was given, pushes topic data to subscriptions (and
// again on `host.set()`), and records acts in `host.calls` as `[verb, ...args]` instead
// of doing them. It speaks the real wire messages over an in-memory transport, so a test
// runs the same code a widget process does, with no socket, Deno or app. SERVE has one entry
// per verb (tsc names one missing); which verbs ask the person and which read a topic is the
// protocol's API row (widget-verbs.ts). It runs in Node under a test runner, never in the
// widget process, so it may take the protocol's values.

import { API, API_ELEMENT_NAMES, API_TOPIC, API_TOPICS } from "@cmd/protocol/widget-tree";
import type {
  ApiAction,
  ApiAgent,
  ApiCompletion,
  ApiCompletionRequest,
  ApiEventClass,
  ApiJournalDay,
  ApiNowPlaying,
  ApiStatQuery,
  ApiStatResult,
  ApiTerminalUsage,
  ApiFetchInit,
  ApiFetchResponse,
  ApiEvent,
  ApiEventQuery,
  ApiGitStatus,
  ApiGitWorktree,
  ApiMethods,
  ApiRunResult,
  ApiScopeQuery,
  ApiStorageMigrate,
  ApiStorageQuery,
  ApiStorageScope,
  ApiTerminal,
  ApiTopic,
  ApiVerb,
  ApiWindow,
  ApiWorkspace,
  WidgetEnv,
  WidgetIn,
  WidgetOut,
  WireValue,
} from "@cmd/protocol/widget-tree";
import type { Transport } from "../connection.ts";
import { classes as fixtureClasses, stat as fixtureStat, workspace as fixtureWorkspace } from "./fixtures.ts";
import { verbs } from "../cmd.ts";
import { WIDGET_API, WIDGET_API_MINOR } from "../version.ts";

/** What the fake core serves. Everything is optional. @since 1.0 */
export interface HostData {
  workspace?: Partial<ApiWorkspace>;
  agents?: ApiAgent[];
  /** Terminals; `screen` is what `terminals.read` returns. */
  terminals?: (ApiTerminal & { screen?: string })[];
  windows?: ApiWindow[];
  events?: ApiEvent[];
  config?: Record<string, WireValue>;
  /**
   * What `cmd.net.fetch` gets, by URL (a body that isn't a string is sent as JSON), or a
   * function of the request. A URL with neither fails the call, naming it.
   */
  fetch?: Record<string, FetchFixture> | ((url: string, init: ApiFetchInit) => FetchFixture | Promise<FetchFixture>);
  /** What `cmd.ai.complete` answers: an answer, or a function of the request. Without it the call fails. */
  ai?: AiFixture | ((req: ApiCompletionRequest) => AiFixture | Promise<AiFixture>);
  /** The window's stored state at start. */
  state?: Record<string, WireValue>;
  git?: ApiGitStatus | null;
  diff?: string;
  worktrees?: ApiGitWorktree[];
  actions?: ApiAction[];
  env?: Partial<WidgetEnv>;
  /** Verbs refused as a grant without them would be, with the permission they need (`'net: ["api.github.com"]'`); a live hook over one (`useEvents` for `events.query`) is refused too. */
  deny?: Partial<Record<ApiVerb, string>>;
  /**
   * What `cmd.run` prints, by the command line (`"gh run list --json name"`: the program and
   * its arguments joined by spaces), or a function of it. A command with neither fails the call.
   * @since 1.1
   */
  run?: Record<string, RunFixture> | ((program: string, args: string[]) => RunFixture | Promise<RunFixture>);
  /**
   * How the person answers the acts (agents.start, terminals.type, …): allowed (the default)
   * or not, as a whole or per verb. A "no" rejects the call with `code: "denied"`.
   * @since 1.1
   */
  approve?: boolean | ((verb: ApiVerb, args: unknown[]) => boolean);
  /** What `cmd.terminals.usage` and `useTerminalUsage` give (`fixtures.usage()`). @since 1.2 */
  terminalUsage?: ApiTerminalUsage[];
  /** The log's classes `cmd.events.classes` lists; `fixtures.classes()` unless given. @since 1.2 */
  classes?: ApiEventClass[];
  /** What `cmd.stats.query` answers, by stat id, or a function of the query; `fixtures.stat()` of the query unless given. @since 1.2 */
  stats?: Record<string, ApiStatResult> | ((q: ApiStatQuery) => ApiStatResult);
  /** The written days `cmd.journal.days` gives, newest first. @since 1.2 */
  journal?: ApiJournalDay[];
  /** What `cmd.media.get` gives: what plays, or null (the default). @since 1.2 */
  playing?: ApiNowPlaying | null;
  /**
   * What `cmd.storage` holds at start, by scope (`window` is `state` too), and the places whose
   * migration is due (`migrate: [{ scope: "package", from: 1, to: 2 }]`): the widget's registered
   * migration runs for each before it renders (`host.migrated` says how each went). `host.set({ storage })` is another window's set: it reaches
   * `useStorage` at once.
   * @since 1.3
   */
  storage?: StorageFixture;
}

/** A fake storage: values by scope, and the places to migrate, in order. @since 1.3 */
export interface StorageFixture {
  window?: Record<string, WireValue>;
  workspace?: Record<string, WireValue>;
  package?: Record<string, WireValue>;
  migrate?: ApiStorageMigrate[];
}

/** A fake program run: exit code 0 and nothing on stderr unless given. @since 1.1 */
export interface RunFixture {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

/** A fake response: status 200 and no headers unless given. @since 1.0 */
export interface FetchFixture {
  status?: number;
  headers?: Record<string, string>;
  body?: WireValue;
}

/** A fake completion: text or an object; usage 0 unless given. @since 1.0 */
export type AiFixture = ({ text: string } | { object: WireValue }) & { usage?: { input: number; output: number } };

/** What `host.calls` records: the acts (not done) but the widget's own state, and what reaches outside (fetches, completions, programs; served from fixtures). */
const records = (v: ApiVerb): boolean => (API[v].mode !== "read" && !v.startsWith("state.") && !v.startsWith("storage.")) || API[v].needs === "net" || API[v].needs === "ai" || API[v].needs === "run";
/** The acts that ask the person (1.1): `approve` answers them. */
const asks = (v: ApiVerb): boolean => API[v].mode === "confirm";

/** Every topic's data is in HostData under the topic's name (tsc fails here otherwise). */
const TOPICS_IN_HOST_DATA: ApiTopic extends keyof HostData ? true : never = true;
void TOPICS_IN_HOST_DATA;

/** A fake core. @since 1.0 */
export interface FakeHost {
  /** The acts, fetches and completions the widget made, in order: `["windows.select", "w-tours"]`. */
  readonly calls: [string, ...unknown[]][];
  /** Every call, reads too. */
  readonly requests: [string, ...unknown[]][];
  /** Every message the process sent. */
  readonly messages: WidgetOut[];
  /** The live subscriptions. */
  subscriptions(): { id: number; topic: ApiTopic; query: unknown }[];
  /** Changes the data and pushes it to subscriptions of what changed. */
  set(data: HostData): void;
  /** Adds events to the log and pushes the matching ones to `events` subscriptions. */
  emit(...events: ApiEvent[]): void;
  /** The process's side of the in-memory wire. */
  readonly transport: Transport;
  /** Sends a message to the process as the core would. */
  deliver(msg: WidgetIn): void;
  /** Messages not yet delivered either way (render waits for none). */
  readonly inFlight: number;
  /** 1.3: what the migration said for each place (`migrated`), in order; empty when none ran. */
  readonly migrated: { scope: ApiStorageScope; ok: boolean; message?: string }[];
  /** 1.3: what `cmd.storage` holds now, by scope (`window` is the window's state). */
  storage(scope: ApiStorageScope): Record<string, WireValue>;
}

const inScope = (q: ApiScopeQuery | null | undefined, wsId: string, item: { workspaceId: string | null }) => q?.scope === "all" || item.workspaceId === wsId;

function matches(q: ApiEventQuery | null | undefined, e: ApiEvent, wsId: string): boolean {
  if (q?.since !== undefined && e.at < q.since) return false;
  if (q?.types?.length && !q.types.some((t) => (t.endsWith(".") ? e.type.startsWith(t) : e.type === t))) return false;
  return inScope({ scope: q?.scope }, wsId, e);
}

/** Makes a fake core serving `data`. @since 1.0 */
export function createHost(data: HostData = {}): FakeHost {
  const d: HostData = { ...data };
  const state = new Map<string, WireValue>(Object.entries({ ...data.state, ...data.storage?.window }));
  const shared = { workspace: new Map(Object.entries(data.storage?.workspace ?? {})), package: new Map(Object.entries(data.storage?.package ?? {})) };
  /** A scope's values: the window's are `state`. */
  const kv = (scope: unknown): Map<string, WireValue> => (scope === "workspace" || scope === "package" ? shared[scope] : state);
  const histories = new Map<string, number[]>();
  const migrated: { scope: ApiStorageScope; ok: boolean; message?: string }[] = [];
  const subs = new Map<number, { topic: ApiTopic; query: unknown }>();
  const calls: [string, ...unknown[]][] = [];
  const requests: [string, ...unknown[]][] = [];
  const messages: WidgetOut[] = [];
  const listeners = new Set<(m: WidgetIn) => void>();
  let inFlight = 0;
  /** Calls being served (a fetch fixture may be async). */
  let pending = 0;
  let opened = 0;

  const ws = (): ApiWorkspace => fixtureWorkspace(d.workspace);
  let started = 0;
  const env = (): WidgetEnv => ({ version: "0.32.0", api: { major: WIDGET_API, minor: WIDGET_API_MINOR }, verbs: Object.keys(verbs) as ApiVerb[], elements: [...API_ELEMENT_NAMES], theme: "dark", size: "regular", placement: "board", ...d.env });

  const deliver = (msg: WidgetIn) => {
    inFlight++;
    queueMicrotask(() => {
      inFlight--;
      for (const fn of [...listeners]) fn(msg);
    });
  };

  /** A topic's data: what its verb answers. */
  const topicData = (topic: ApiTopic, query: unknown): WireValue => {
    if (topic === "storage") return SERVE["storage.get"]([(query as ApiStorageQuery | null)?.scope, (query as ApiStorageQuery | null)?.key] as never) as WireValue;
    return SERVE[API_TOPIC[topic].verb]([query ?? null] as never) as WireValue;
  };

  const fetchOf = async (url: string, init: ApiFetchInit): Promise<ApiFetchResponse> => {
    const f = typeof d.fetch === "function" ? await d.fetch(url, init) : d.fetch?.[url];
    if (!f) throw new Error(`No fetch fixture for ${init.method ?? "GET"} ${url}: give createHost({ fetch: { "${url}": { body } } })`);
    return { status: f.status ?? 200, headers: f.headers ?? {}, body: typeof f.body === "string" ? f.body : f.body === undefined ? "" : JSON.stringify(f.body), clipped: false };
  };
  const aiOf = async (req: ApiCompletionRequest): Promise<ApiCompletion> => {
    const a = typeof d.ai === "function" ? await d.ai(req) : d.ai;
    if (!a) throw new Error("No AI answer: give createHost({ ai: { text } })");
    return { ...a, usage: a.usage ?? { input: 0, output: 0 } };
  };

  const runOf = async (program: string, args: string[]): Promise<ApiRunResult> => {
    const line = [program, ...args].join(" ");
    const f = typeof d.run === "function" ? await d.run(program, args) : d.run?.[line];
    if (!f) throw new Error(`No run fixture for ${line}: give createHost({ run: { "${line}": { stdout } } })`);
    return { code: f.code === undefined ? 0 : f.code, stdout: f.stdout ?? "", stderr: f.stderr ?? "", timedOut: !!f.timedOut, clipped: false };
  };

  const id = () => ws().id;
  const terminal = (tid: unknown) => (d.terminals ?? []).find((t) => t.id === tid);
  const done = () => null;
  /** Each verb, as the fake answers it (arguments as the process sent them). */
  const SERVE: { [V in ApiVerb]: (p: Partial<ApiMethods[V]["params"]>) => unknown } = {
    "workspace.get": () => ws(),
    "workspace.windows": () => (d.windows ?? []).filter((w) => w.workspaceId === id()),
    "workspace.selected": () => (d.windows ?? []).find((w) => w.workspaceId === id() && w.selected) ?? null,
    "agents.list": ([q]) => (d.agents ?? []).filter((a) => inScope(q, id(), a)),
    "agents.get": ([aid]) => (d.agents ?? []).find((a) => a.id === aid) ?? null,
    "terminals.list": ([q]) => (d.terminals ?? []).filter((t) => inScope(q, id(), t)).map(({ screen: _, ...t }) => t),
    "terminals.read": ([tid, opts]) => {
      const t = terminal(tid);
      if (!t) throw new Error(`No terminal ${String(tid)}`);
      const lines = (t.screen ?? "").split("\n");
      const want = opts?.lines ?? lines.length;
      return { text: lines.slice(-want).join("\n"), clipped: want < lines.length, untrusted: true };
    },
    "terminals.waitFor": ([tid, pattern]) => {
      const re = new RegExp(String(pattern));
      const line = (terminal(tid)?.screen ?? "").split("\n").find((l) => re.test(l)) ?? null;
      return { matched: line !== null, line };
    },
    "windows.list": ([q]) => (d.windows ?? []).filter((w) => inScope(q, id(), w)),
    "windows.open": () => ({ id: `w-opened-${++opened}` }),
    "windows.select": done,
    "events.query": ([q]) => (d.events ?? []).filter((e) => matches(q, e, id())).slice(-(q?.limit ?? 200)),
    "events.stats": ([q]) => {
      const list = (d.events ?? []).filter((e) => matches(q, e, id()));
      const byType: Record<string, number> = {};
      for (const e of list) byType[e.type] = (byType[e.type] ?? 0) + 1;
      return { total: list.length, byType };
    },
    "git.status": () => d.git ?? null,
    "git.diff": () => ({ text: d.diff ?? "", clipped: false }),
    "git.worktrees": () => d.worktrees ?? [],
    "actions.list": () => d.actions ?? [],
    "notify.send": done,
    "state.get": ([key]) => state.get(String(key)) ?? null,
    "state.set": ([key, value]) => (state.set(String(key), value as WireValue), null),
    "state.history": ([key, value, max]) => history(`window\n${String(key)}`, value, max),
    "net.fetch": ([url, init]) => fetchOf(String(url), init ?? {}),
    "ai.complete": ([req]) => aiOf(req as ApiCompletionRequest),
    "agents.start": () => {
      const n = ++started;
      return { id: `a-started-${n}`, terminalId: `t-started-${n}`, windowId: `t-started-${n}` };
    },
    "agents.send": done,
    "agents.stop": done,
    "terminals.type": done,
    "terminals.open": () => ({ id: `w-opened-${++opened}` }),
    "actions.run": ([name]) => {
      const a = (d.actions ?? []).find((x) => x.name === name);
      if (!a) throw new Error(`No action ${String(name)}`);
      if (a.risky) throw new Error(`“${a.name}” is risky: run it from Workspace Actions.`);
      return { terminalId: `t-action-${a.name}`, started: true };
    },
    "windows.close": done,
    "run.exec": ([program, args]) => runOf(String(program), Array.isArray(args) ? args.map(String) : []),
    // 1.2
    "actions.stop": ([name]) => {
      if (!(d.actions ?? []).some((x) => x.name === name)) throw new Error(`No action ${String(name)}`);
      return null;
    },
    "events.classes": () => d.classes ?? fixtureClasses(),
    "terminals.usage": ([q]) => (d.terminalUsage ?? []).filter((u) => inScope(q, id(), u)),
    "stats.query": ([q]) => {
      const query = (q ?? { stat: "" }) as ApiStatQuery;
      return typeof d.stats === "function" ? d.stats(query) : (d.stats?.[query.stat] ?? fixtureStat(query));
    },
    "journal.days": ([q]) => (d.journal ?? []).slice(0, Math.min(q?.count ?? 7, 30)),
    "media.get": () => d.playing ?? null,
    "media.control": done,
    "clipboard.write": done,
    // 1.3
    "storage.get": ([scope, key]) => kv(scope).get(String(key)) ?? null,
    "storage.set": ([scope, key, value]) => (store(scope, String(key), value ?? null), null),
    "storage.delete": ([scope, key]) => (store(scope, String(key), null), null),
    "storage.keys": ([scope, prefix]) => [...kv(scope).keys()].filter((k) => k.startsWith(prefix ?? "")).sort(),
    "storage.history": ([scope, key, value, max]) => history(`${String(scope ?? "window")}\n${String(key)}`, value, max),
  };
  function history(at: string, value: unknown, max: unknown): number[] {
    const all = [...(histories.get(at) ?? []), ...(typeof value === "number" ? [value] : [])].slice(-1000);
    histories.set(at, all);
    return all.slice(-(Number(max) || 60));
  }
  /** A set (or a delete, null), and the live `storage` subscriptions of its key told. */
  function store(scope: unknown, key: string, value: WireValue | null): void {
    if (value === null) kv(scope).delete(key);
    else kv(scope).set(key, value);
    for (const [id, s] of subs) {
      const q = s.query as ApiStorageQuery | null;
      if (s.topic === "storage" && q?.scope === scope && q?.key === key) deliver({ kind: "event", sub: id, data: value });
    }
  }
  const serve = (method: string, p: unknown[]): unknown => {
    if (!Object.hasOwn(SERVE, method)) throw Object.assign(new Error(`This cmd doesn't serve ${method}.`), { code: "unknown" });
    return (SERVE[method as ApiVerb] as (p: unknown[]) => unknown)(p);
  };

  const receive = (m: WidgetOut) => {
    messages.push(m);
    switch (m.kind) {
      case "hello":
        deliver({ kind: "ready", env: env(), config: d.config ?? {}, state: Object.fromEntries(state), ...(d.storage?.migrate?.length ? { migrate: d.storage.migrate } : {}) });
        return;
      case "migrated":
        migrated.push({ scope: m.scope, ok: m.ok, ...(m.message ? { message: m.message } : {}) });
        return;
      case "call": {
        requests.push([m.method, ...m.params]);
        const denied = d.deny?.[m.method];
        if (denied) return deliver({ kind: "result", id: m.id, ok: false, error: { code: "permission", permission: denied, message: `Add "${denied}" to the widget's permissions to use ${m.method}.` } });
        const approve = typeof d.approve === "function" ? d.approve(m.method, m.params) : d.approve !== false;
        if (Object.hasOwn(API, m.method) && asks(m.method) && !approve) return deliver({ kind: "result", id: m.id, ok: false, error: { code: "denied", message: "The person said no." } });
        if (Object.hasOwn(API, m.method) && records(m.method)) calls.push([m.method, ...m.params]);
        const fail = (e: unknown) => {
          const code = (e as { code?: string }).code === "unknown" ? "unknown" : "failed";
          deliver({ kind: "result", id: m.id, ok: false, error: { code, message: (e as Error).message } });
        };
        pending++;
        Promise.resolve()
          .then(() => serve(m.method, m.params))
          .then((v) => deliver({ kind: "result", id: m.id, ok: true, value: (v ?? null) as WireValue }), fail)
          .finally(() => pending--);
        return;
      }
      case "subscribe": {
        // A live read of a refused verb is refused as the core refuses it: a failed result under its id.
        const denied = d.deny?.[API_TOPIC[m.topic].verb];
        if (denied) return deliver({ kind: "result", id: m.id, ok: false, error: { code: "permission", permission: denied, message: `Add "${denied}" to the widget's permissions to use ${API_TOPIC[m.topic].verb}.` } });
        subs.set(m.id, { topic: m.topic, query: m.query });
        deliver({ kind: "event", sub: m.id, data: topicData(m.topic, m.query) });
        return;
      }
      case "unsubscribe":
        subs.delete(m.id);
        return;
    }
  };

  return {
    calls,
    requests,
    messages,
    subscriptions: () => [...subs].map(([id, s]) => ({ id, ...s })),
    set(next) {
      Object.assign(d, next);
      // Another window's sets: each value (null deletes) reaches this one's useStorage.
      for (const scope of ["window", "workspace", "package"] as const) for (const [k, v] of Object.entries(next.storage?.[scope] ?? {})) store(scope, k, v);
      if (next.config) deliver({ kind: "config", config: next.config });
      if (next.env) deliver({ kind: "env", env: env() });
      // A topic's data is under its name; events come through emit().
      const changed = new Set(API_TOPICS.filter((t) => t !== "events" && t !== "storage" && t in next));
      if (next.workspace) for (const t of ["agents", "terminals", "windows"] as const) changed.add(t);
      for (const [id, s] of subs) if (changed.has(s.topic)) deliver({ kind: "event", sub: id, data: topicData(s.topic, s.query) });
    },
    emit(...events) {
      d.events = [...(d.events ?? []), ...events];
      for (const [id, s] of subs) {
        if (s.topic !== "events") continue;
        const hit = events.filter((e) => matches(s.query as ApiEventQuery, e, ws().id));
        if (hit.length) deliver({ kind: "event", sub: id, data: hit as unknown as WireValue });
      }
    },
    transport: {
      send(m) {
        inFlight++;
        queueMicrotask(() => {
          inFlight--;
          receive(m);
        });
      },
      listen(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    deliver,
    get migrated() {
      return migrated;
    },
    storage: (scope) => Object.fromEntries(kv(scope)),
    get inFlight() {
      return inFlight + pending;
    },
  };
}

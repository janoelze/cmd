// A fake core for widget tests: `createHost({ agents, … })` answers the process's hello,
// serves the reads from the data it was given, pushes topic data to subscriptions (and
// again on `host.set()`), and records acts in `host.calls` as `[verb, ...args]` instead
// of doing them. It speaks the real wire messages over an in-memory transport, so a test
// runs the same code a widget process does, with no socket, Deno or app.

import type {
  ApiAction,
  ApiAgent,
  ApiCompletion,
  ApiCompletionRequest,
  ApiFetchInit,
  ApiFetchResponse,
  ApiEvent,
  ApiEventQuery,
  ApiGitStatus,
  ApiGitWorktree,
  ApiRunResult,
  ApiScopeQuery,
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
import { workspace as fixtureWorkspace } from "./fixtures.ts";
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
  /** Verbs refused as a grant without them would be, with the permission they need (`'net: ["api.github.com"]'`). */
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

/** What `host.calls` records: the acts (not done), and what reaches outside (fetches, completions, programs; served from fixtures). */
const ACTS = new Set<string>(["windows.open", "windows.select", "notify.send", "net.fetch", "ai.complete", "agents.start", "agents.send", "agents.stop", "terminals.type", "terminals.open", "actions.run", "windows.close", "run.exec"]);
/** The acts that ask the person (1.1): `approve` answers them. */
const ASKS = new Set<string>(["agents.start", "agents.send", "agents.stop", "terminals.type", "terminals.open", "actions.run", "windows.close"]);

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
  const state = new Map<string, WireValue>(Object.entries(data.state ?? {}));
  const histories = new Map<string, number[]>();
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
  const env = (): WidgetEnv => ({ version: "0.32.0", api: { major: WIDGET_API, minor: WIDGET_API_MINOR }, verbs: Object.keys(verbs) as ApiVerb[], theme: "dark", size: "regular", placement: "board", ...d.env });

  const deliver = (msg: WidgetIn) => {
    inFlight++;
    queueMicrotask(() => {
      inFlight--;
      for (const fn of [...listeners]) fn(msg);
    });
  };

  const topicData = (topic: ApiTopic, query: unknown): WireValue => {
    const id = ws().id;
    const q = query as ApiScopeQuery | null;
    const v: unknown =
      topic === "workspace" ? ws()
      : topic === "agents" ? (d.agents ?? []).filter((a) => inScope(q, id, a))
      : topic === "terminals" ? (d.terminals ?? []).filter((t) => inScope(q, id, t)).map(({ screen: _, ...t }) => t)
      : topic === "windows" ? (d.windows ?? []).filter((w) => inScope(q, id, w))
      : topic === "events" ? (d.events ?? []).filter((e) => matches(query as ApiEventQuery, e, id)).slice(-((query as ApiEventQuery | null)?.limit ?? 200))
      : topic === "git" ? (d.git ?? null)
      : (d.actions ?? []);
    return v as WireValue;
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

  const serve = (method: string, p: unknown[]): unknown => {
    const id = ws().id;
    const terminal = () => (d.terminals ?? []).find((t) => t.id === p[0]);
    switch (method) {
      case "workspace.get": return ws();
      case "workspace.windows": return (d.windows ?? []).filter((w) => w.workspaceId === id);
      case "workspace.selected": return (d.windows ?? []).find((w) => w.workspaceId === id && w.selected) ?? null;
      case "agents.list": return (d.agents ?? []).filter((a) => inScope(p[0] as ApiScopeQuery, id, a));
      case "agents.get": return (d.agents ?? []).find((a) => a.id === p[0]) ?? null;
      case "terminals.list": return topicData("terminals", p[0] ?? null);
      case "terminals.read": {
        const t = terminal();
        if (!t) throw new Error(`No terminal ${String(p[0])}`);
        const lines = (t.screen ?? "").split("\n");
        const want = (p[1] as { lines?: number } | undefined)?.lines ?? lines.length;
        return { text: lines.slice(-want).join("\n"), clipped: want < lines.length, untrusted: true };
      }
      case "terminals.waitFor": {
        const re = new RegExp(String(p[1]));
        const line = (terminal()?.screen ?? "").split("\n").find((l) => re.test(l)) ?? null;
        return { matched: line !== null, line };
      }
      case "windows.list": return topicData("windows", p[0] ?? null);
      case "windows.open": return { id: `w-opened-${++opened}` };
      case "windows.select": return null;
      case "events.query": return topicData("events", p[0] ?? null);
      case "events.stats": {
        const list = (d.events ?? []).filter((e) => matches(p[0] as ApiEventQuery, e, id));
        const byType: Record<string, number> = {};
        for (const e of list) byType[e.type] = (byType[e.type] ?? 0) + 1;
        return { total: list.length, byType };
      }
      case "git.status": return d.git ?? null;
      case "git.diff": return { text: d.diff ?? "", clipped: false };
      case "git.worktrees": return d.worktrees ?? [];
      case "actions.list": return d.actions ?? [];
      case "notify.send": return null;
      case "state.get": return state.get(String(p[0])) ?? null;
      case "state.set": state.set(String(p[0]), p[1] as WireValue); return null;
      case "state.history": {
        const key = String(p[0]);
        const max = (p[2] as number | undefined) ?? 60;
        const h = [...(histories.get(key) ?? []), ...(typeof p[1] === "number" ? [p[1]] : [])].slice(-max);
        histories.set(key, h);
        return h;
      }
      case "net.fetch": return fetchOf(String(p[0]), (p[1] ?? {}) as ApiFetchInit);
      case "ai.complete": return aiOf(p[0] as ApiCompletionRequest);
      case "agents.start": {
        const n = ++started;
        return { id: `a-started-${n}`, terminalId: `t-started-${n}`, windowId: `t-started-${n}` };
      }
      case "agents.send":
      case "agents.stop":
      case "terminals.type":
      case "windows.close":
        return null;
      case "terminals.open": return { id: `w-opened-${++opened}` };
      case "actions.run": {
        const a = (d.actions ?? []).find((x) => x.name === p[0]);
        if (!a) throw new Error(`No action ${String(p[0])}`);
        if (a.risky) throw new Error(`“${a.name}” is risky: run it from Workspace Actions.`);
        return { terminalId: `t-action-${a.name}`, started: true };
      }
      case "run.exec": return runOf(String(p[0]), Array.isArray(p[1]) ? p[1].map(String) : []);
    }
    throw Object.assign(new Error(`This cmd doesn't serve ${method}.`), { code: "unknown" });
  };

  const receive = (m: WidgetOut) => {
    messages.push(m);
    switch (m.kind) {
      case "hello":
        deliver({ kind: "ready", env: env(), config: d.config ?? {}, state: Object.fromEntries(state) });
        return;
      case "call": {
        requests.push([m.method, ...m.params]);
        const denied = d.deny?.[m.method];
        if (denied) return deliver({ kind: "result", id: m.id, ok: false, error: { code: "permission", permission: denied, message: `Add "${denied}" to the widget's permissions to use ${m.method}.` } });
        const approve = typeof d.approve === "function" ? d.approve(m.method, m.params) : d.approve !== false;
        if (ASKS.has(m.method) && !approve) return deliver({ kind: "result", id: m.id, ok: false, error: { code: "denied", message: "The person said no." } });
        if (ACTS.has(m.method)) calls.push([m.method, ...m.params]);
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
      case "subscribe":
        subs.set(m.id, { topic: m.topic, query: m.query });
        deliver({ kind: "event", sub: m.id, data: topicData(m.topic, m.query) });
        return;
      case "unsubscribe":
        subs.delete(m.id);
        return;
    }
  };

  const TOPIC_OF: Partial<Record<keyof HostData, ApiTopic>> = { workspace: "workspace", agents: "agents", terminals: "terminals", windows: "windows", git: "git", actions: "actions" };

  return {
    calls,
    requests,
    messages,
    subscriptions: () => [...subs].map(([id, s]) => ({ id, ...s })),
    set(next) {
      Object.assign(d, next);
      if (next.config) deliver({ kind: "config", config: next.config });
      if (next.env) deliver({ kind: "env", env: env() });
      const changed = new Set(Object.keys(next).map((k) => TOPIC_OF[k as keyof HostData]).filter(Boolean));
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
    get inFlight() {
      return inFlight + pending;
    },
  };
}

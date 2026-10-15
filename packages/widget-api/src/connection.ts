// The widget process's side of the wire (docs/56, "The runtime"): one Connection per
// process over an abstract Transport (the widgets socket in Deno, an in-memory pair in
// tests). It numbers calls and subscriptions, matches results and events to them, and
// keeps what the core pushes (env, config, the window's stored state) for the hooks.
// The `cmd` object and the hooks reach it through `connection()`: one widget per process.

import type { ApiError, ApiStorageMigrate, ApiTopic, ApiVerb, TopicQuery, WidgetEnv, WidgetIn, WidgetOut, WireValue } from "@cmd/protocol/widget-tree";

/** How a process talks to the core: send a message, hear messages. Item C's socket, or testing's pair. */
export interface Transport {
  send(msg: WidgetOut): void;
  /** Called with every message from the core; returns a function that stops listening. */
  listen(fn: (msg: WidgetIn) => void): () => void;
}

/** A verb the core refused or that failed: `code` says which, `permission` what to add to package.json. */
export class ApiCallError extends Error {
  readonly code: ApiError["code"];
  readonly permission: string | undefined;
  constructor(e: ApiError) {
    super(e.message);
    this.name = "ApiCallError";
    this.code = e.code;
    this.permission = e.permission;
  }
}

const EMPTY_ENV: WidgetEnv = { version: "0.0.0", api: { major: 1, minor: 0 }, verbs: [], theme: "dark", size: "regular", placement: "board" };

export class Connection {
  readonly transport: Transport;
  env: WidgetEnv = EMPTY_ENV;
  config: Record<string, WireValue> = {};
  /** The window's stored state as last known here (sets apply locally at once). */
  readonly state = new Map<string, WireValue>();
  /** 1.3: the storage migration `ready` asked this process to run first, or null. */
  migrate: ApiStorageMigrate | null = null;
  /** The handlers of the tree, by id (the reconciler fills it). */
  readonly handlers = new Map<number, (value?: unknown) => unknown>();
  /** Called on `resync` (the reconciler sends the whole tree again). */
  onResync: (() => void) | null = null;
  /** Runs a handler for an interaction (the reconciler makes it a discrete update). */
  runHandler: (fn: (value?: unknown) => unknown, value: unknown) => void = (fn, value) => void fn(value);

  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private readonly subs = new Map<number, { fn: (data: unknown) => void; onError?: (e: ApiCallError) => void }>();
  private readonly watchers = new Set<() => void>();
  private readonly stop: () => void;
  private readyResolve!: () => void;
  readonly ready: Promise<void>;
  /** Calls and subscriptions not yet answered (testing waits for none). */
  get busy(): number {
    return this.pending.size;
  }

  constructor(transport: Transport) {
    this.transport = transport;
    this.ready = new Promise((r) => (this.readyResolve = r));
    this.stop = transport.listen((m) => this.receive(m));
  }

  send(msg: WidgetOut): void {
    this.transport.send(msg);
  }

  call(method: ApiVerb, params: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    // Trailing undefined arguments don't cross (JSON has none); inner ones become null.
    while (params.length && params[params.length - 1] === undefined) params = params.slice(0, -1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ kind: "call", id, method, params: params.map((p) => (p === undefined ? null : (p as WireValue))) });
    });
  }

  /** `onError`: the core refused it (a `result` with ok: false under its id); it has ended then. */
  subscribe<T extends ApiTopic>(topic: T, query: TopicQuery[T] | null, fn: (data: unknown) => void, onError?: (e: ApiCallError) => void): () => void {
    const id = this.nextId++;
    this.subs.set(id, { fn, onError });
    this.send({ kind: "subscribe", id, topic, query });
    return () => {
      if (!this.subs.delete(id)) return;
      this.send({ kind: "unsubscribe", id });
    };
  }

  /** Called when env, config or state change (useSyncExternalStore). */
  watch(fn: () => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /** Sets a stored value here at once, null deletes it (the core is told by the caller). */
  setState(key: string, value: WireValue): void {
    if (value === null) this.state.delete(key);
    else this.state.set(key, value);
    this.changed();
  }

  close(): void {
    this.stop();
    for (const p of this.pending.values()) p.reject(new ApiCallError({ code: "failed", message: "The widget stopped." }));
    this.pending.clear();
    this.subs.clear();
  }

  private changed(): void {
    for (const fn of [...this.watchers]) fn();
  }

  private receive(m: WidgetIn): void {
    switch (m.kind) {
      case "ready":
        this.env = m.env;
        this.config = m.config;
        for (const [k, v] of Object.entries(m.state)) this.state.set(k, v);
        this.migrate = m.migrate ?? null;
        this.readyResolve();
        this.changed();
        return;
      case "result": {
        const p = this.pending.get(m.id);
        if (!p) {
          // A refused subscription: it ends, and its subscriber hears why.
          const sub = m.ok ? undefined : this.subs.get(m.id);
          if (sub && !m.ok) {
            this.subs.delete(m.id);
            sub.onError?.(new ApiCallError(m.error));
          }
          return;
        }
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new ApiCallError(m.error));
        return;
      }
      case "event":
        this.subs.get(m.sub)?.fn(m.data);
        return;
      case "interaction": {
        const fn = this.handlers.get(m.handler);
        if (fn) this.runHandler(fn, m.value);
        return;
      }
      case "config":
        this.config = m.config;
        this.changed();
        return;
      case "env":
        this.env = m.env;
        this.changed();
        return;
      case "resync":
        this.onResync?.();
        return;
    }
  }
}

let current: Connection | null = null;

/** The process's connection; `cmd.*` outside a running widget is a mistake worth a clear error. */
export function connection(): Connection {
  if (!current) throw new Error("@cmd/widget-api: no widget is running (render it with run() or testing's render())");
  return current;
}

export function setConnection(c: Connection | null): void {
  current = c;
}

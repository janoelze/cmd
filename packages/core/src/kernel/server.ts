// The core's side of every connection: the Unix socket (and the widgets socket beside it),
// JSON-RPC over it or over a paired device's session, and events out. A connection's own
// state (the windows it shows, the files it watches, what events it wants) lives here; what
// a feature keeps per connection it drops in onClosed. Handlers run through `dispatch`.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { CoreEvent, DataQuery, Method, StatQuery } from "@cmd/protocol";
import { lineSplitter, MAX_LINE, RPC_CODES, RpcError } from "@cmd/protocol";
import { ipcPath, logger, recordCrash } from "@cmd/protocol/node";
import { widgetRead, widgetStats, type WidgetIdentity } from "../data/widgets.ts";
import { checkRemoteCall, RemoteDenied, remoteResult, type PolicyContext } from "../remote/policy.ts";
import type { Connection, Served } from "./connection.ts";
import { ConnectionWriter } from "./writer.ts";
import type { CoreContext } from "./context.ts";
import type { Call } from "./handlers.ts";

const log = logger("core");
const rpcLog = logger("rpc");

/** The widgets socket lives beside the main one. */
export const widgetsSocketPath = (socketPath: string) => path.join(path.dirname(socketPath), "widgets.sock");
/** The longest Unix socket path macOS connects to: sun_path is 104 bytes, its NUL included. */
export const SOCKET_PATH_MAX = 103;

/** What the core keeps about one connection. */
export interface ConnState {
  /** Windows it shows (window.follow); remote sessions get output only for these. */
  follows: ReadonlySet<string>;
  /** Paths it watches (fs.watch), let go when it closes. */
  watches: string[];
}

export interface ServerOptions {
  socketPath: string;
  /** How often to check that the socket file is still there (default 2 s). */
  socketCheckMs?: number;
  /** The socket's folder was deleted (a removed worktree's .cmd-dev), gone or made again since by something writing into it: this instance is over. Not put back. */
  onHomeGone?: () => void;
  build?: string;
  /** Runs a method for a caller (Core.handlers). */
  dispatch: (method: Method, params: unknown, call: Call) => Promise<unknown>;
  /** What remote/policy.ts checks a remote call's arguments against. */
  policy: () => PolicyContext;
}

type ServerCore = Pick<CoreContext, "scheduler" | "remote" | "widgetTokens" | "data" | "watches" | "stats">;

export class CoreServer {
  #core: ServerCore;
  #o: ServerOptions;
  /** Listening servers: one, plus one per time the socket file was put back (the old ones keep their clients). */
  #servers: net.Server[] = [];
  /** Open socket connections, cut on close so a lingering client can't hold it up. */
  #sockets = new Set<net.Socket>();
  /** Inode of the socket file this core created: on close, it removes that file only, not another's. */
  #sockIno: number | null = null;
  #sockCheck: ReturnType<typeof setInterval> | null = null;
  /** The socket folder's inode when first bound: a different one later means it was deleted (and made again by a write). */
  #homeIno: number | null = null;
  #sockError: string | null = null;
  #widgetsBound = false;
  #rebinding = false;
  #closed = false;
  #conns = new Map<Connection, ConnState>();
  /** Subscribed connections and which events each wants: false to skip one, or the event as this connection gets it (a remote one's, remote/policy.ts). */
  #subscribers = new Map<Connection, (e: CoreEvent) => boolean | CoreEvent | null>();
  /** Connections on the widgets socket, and which widget each said it is (null until widget.hello). */
  #widgetConns = new Map<Connection, WidgetIdentity | null>();
  /** Widget connections a package widget's host took over after hello (data/widgets.ts `attach`). */
  #hosted = new Map<Connection, { receive(line: string): void; closed(): void }>();
  #onClosed: ((conn: Connection) => void)[] = [];

  constructor(core: ServerCore, o: ServerOptions) {
    this.#core = core;
    this.#o = o;
  }

  /** Open socket connections. */
  get connections(): number {
    return this.#sockets.size;
  }

  /** Whether any connection is subscribed to events. */
  watched(): boolean {
    return this.#subscribers.size > 0;
  }

  /** A connection's state (an empty one for a connection the server doesn't serve). */
  state(conn: Connection): ConnState {
    let s = this.#conns.get(conn);
    if (!s) this.#conns.set(conn, (s = { follows: new Set(), watches: [] }));
    return s;
  }

  setFollows(conn: Connection, ids: string[]): void {
    this.state(conn).follows = new Set(ids);
  }

  /** From now on `conn` gets the events `wants` lets through. */
  subscribe(conn: Connection, wants: (e: CoreEvent) => boolean | CoreEvent | null): void {
    this.#subscribers.set(conn, wants);
  }

  /** What remote calls and views are checked against (remote/policy.ts). */
  policy(): PolicyContext {
    return this.#o.policy();
  }

  /** What a feature keeps per connection goes when the connection does. */
  onClosed(fn: (conn: Connection) => void): void {
    this.#onClosed.push(fn);
  }

  broadcast(event: CoreEvent): void {
    if (this.#subscribers.size === 0) return;
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }) + "\n";
    for (const [c, wants] of this.#subscribers) {
      const got = wants(event);
      if (!got) continue;
      const [e, l] = got === true || got === event ? [event, line] : [got, JSON.stringify({ jsonrpc: "2.0", method: "event", params: got }) + "\n"];
      if (c.event) c.event(e, l);
      else c.send(l);
    }
  }

  /** One event to one connection. */
  send(conn: Connection, event: CoreEvent): void {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }) + "\n";
    if (conn.event) conn.event(event, line);
    else conn.send(line);
  }

  /** Cut every subscribed client: they reconnect and load the core's state afresh. */
  disconnectAll(): void {
    for (const s of this.#subscribers.keys()) s.close();
  }

  async listen(): Promise<void> {
    await this.#bind();
    // The socket file can go while we run (removed by hand, a temp-dir cleaner):
    // put it back, or clients find no core and the app starts another.
    if (this.#sockIno !== null) {
      this.#sockCheck = setInterval(() => void this.#checkSocket(), this.#o.socketCheckMs ?? 2000);
      this.#sockCheck.unref();
    }
  }

  async #bind(): Promise<void> {
    const sock = ipcPath(this.#o.socketPath);
    // A named pipe (Windows) has no file: nothing to create, clean up or chmod,
    // and listening on a taken pipe fails by itself.
    const isFile = sock === this.#o.socketPath;
    if (isFile) {
      fs.mkdirSync(path.dirname(sock), { recursive: true });
      this.#homeIno ??= fs.statSync(path.dirname(sock)).ino;
      await removeStaleSocket(sock);
    }
    // A file socket is bound under a temporary name, then renamed into place:
    // closing a server unlinks the path it was bound to (libuv), and by then
    // that path may be another process's socket. The rename is atomic, too.
    const bindTo = isFile ? path.join(path.dirname(sock), `.${process.pid}-${this.#servers.length}.sock`) : sock;
    if (isFile) fs.rmSync(bindTo, { force: true });
    const server = net.createServer((sock) => this.#serveSocket(sock));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindTo, () => resolve());
    });
    this.#servers.push(server);
    if (isFile) {
      fs.chmodSync(bindTo, 0o600);
      fs.renameSync(bindTo, sock);
      this.#sockIno = fs.statSync(sock).ino;
      await this.#bindWidgets();
    }
  }

  /**
   * The widgets socket beside the main one: every connection on it is a widget's
   * data.ts (see #widgetCall). Secondary to the main socket: a core that took
   * the main path takes this one too (renamed over, atomically), and a rebind
   * of the main socket keeps the one already there.
   */
  async #bindWidgets(): Promise<void> {
    const sock = widgetsSocketPath(this.#o.socketPath);
    if (this.#widgetsBound && fs.existsSync(sock)) return;
    // Node binds longer paths, but Deno can't connect to them: data.ts's events() would fail.
    const bytes = Buffer.byteLength(sock);
    if (bytes > SOCKET_PATH_MAX) log.warn(`widgets can't read the event log: the widgets socket path is ${bytes} bytes, more than the ${SOCKET_PATH_MAX} macOS allows. Set CMD_HOME to a shorter folder.`, { path: sock });
    const bindTo = path.join(path.dirname(sock), `.${process.pid}-${this.#servers.length}-w.sock`);
    fs.rmSync(bindTo, { force: true });
    const server = net.createServer((s) => this.#serveSocket(s, true));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindTo, () => resolve());
    });
    this.#servers.push(server);
    fs.chmodSync(bindTo, 0o600);
    fs.renameSync(bindTo, sock);
    this.#widgetsBound = true;
  }

  async #checkSocket(): Promise<void> {
    if (this.#closed || this.#rebinding) return;
    let ino: number | null = null;
    try {
      ino = fs.statSync(this.#o.socketPath).ino;
    } catch {}
    // The file alone went (a cleanup of stale sockets): put it back. Its folder went with
    // it: the state dir was deleted, and rebinding would make it again (mkdir) for a core
    // nobody can reach any more, the folder coming back after every removed worktree. A
    // write since (a model list, a log) may have made the folder again: a new inode.
    let dirIno: number | null = null;
    try {
      dirIno = fs.statSync(path.dirname(this.#o.socketPath)).ino;
    } catch {}
    if (this.#homeIno !== null && dirIno !== this.#homeIno && ino !== this.#sockIno) {
      if (this.#sockCheck) clearInterval(this.#sockCheck);
      log.warn(`the state dir ${path.dirname(this.#o.socketPath)} is gone: not putting the socket back`);
      this.#o.onHomeGone?.();
      return;
    }
    if (ino === this.#sockIno) return;
    this.#rebinding = true;
    try {
      await this.#bind();
      log.warn(`the socket file was gone or replaced: listening on ${this.#o.socketPath} again`);
      this.#sockError = null;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== this.#sockError) log.warn(`could not put the socket back: ${msg}`);
      this.#sockError = msg;
    } finally {
      this.#rebinding = false;
    }
  }

  /** A Unix socket client: local access. */
  #serveSocket(sock: net.Socket, widget = false): void {
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    this.#sockets.add(sock);
    rpcLog.debug(widget ? "widget connection opened" : "connection opened");
    const writer = new ConnectionWriter({
      write: (line) => !sock.writable || sock.write(line),
      buffered: () => sock.writableLength,
      close: (reason) => {
        rpcLog.warn(`a client stopped reading (${reason}): closing it`);
        sock.destroy();
      },
    });
    sock.on("drain", () => writer.drain());
    const conn: Connection = {
      access: "local",
      send: (line) => writer.send(line),
      event: (e, line) => writer.event(e, line),
      close: () => sock.destroy(),
    };
    if (widget) this.#widgetConns.set(conn, null);
    const served = this.serve(conn);
    sock.on("close", () => {
      writer.dispose();
      this.#sockets.delete(sock);
      this.#widgetConns.delete(conn);
      this.#hosted.get(conn)?.closed();
      this.#hosted.delete(conn);
      rpcLog.debug("connection closed");
      served.closed();
    });
    const tooLong = () => {
      rpcLog.warn(`a client sent a message over ${MAX_LINE / 1024 / 1024} MB: closing it`);
      sock.destroy();
    };
    sock.on("data", lineSplitter((line) => served.receive(line), { max: MAX_LINE, tooLong }));
  }

  /** JSON-RPC over any connection; a remote one is held to remote/policy.ts. */
  serve(conn: Connection): Served {
    return {
      receive: (line) => void this.#receive(conn, line),
      closed: () => {
        this.#subscribers.delete(conn);
        for (const p of this.#conns.get(conn)?.watches ?? []) this.#core.watches.unwatch(p);
        this.#conns.delete(conn);
        for (const fn of this.#onClosed) fn(conn);
      },
    };
  }

  async #receive(conn: Connection, line: string): Promise<void> {
    if (!line.trim()) return;
    const hosted = this.#hosted.get(conn);
    if (hosted) return hosted.receive(line);
    const answer = (id: unknown, msg: object) => conn.send(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...msg }) + "\n");
    let req: { id?: number; method: Method; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return answer(null, { error: { code: RPC_CODES.parse, message: "not JSON" } });
    }
    if (typeof req !== "object" || req === null || typeof req.method !== "string") return answer((req as { id?: unknown } | null)?.id, { error: { code: RPC_CODES.invalidRequest, message: "not a request: no method" } });
    // A notification (no id) is run and not answered.
    const reply = (msg: object) => "id" in req && req.id !== undefined && answer(req.id, msg);
    try {
      const params = (req.params ?? {}) as Record<string, unknown>;
      // A widget's data.ts: it says which widget it is, then it may read events, nothing else.
      if (this.#widgetConns.has(conn)) {
        reply({ result: this.#widgetCall(conn, req.method, params) });
        return;
      }
      if (conn.access !== "local") checkRemoteCall(req.method, params as never, conn.access, this.#o.policy());
      // Named for the watchdog up to the handler's first await, and again for the reply (a big result is a long stringify).
      const name = `rpc ${req.method}`;
      let done = this.#core.scheduler.mark(name);
      let result;
      try {
        result = await this.#o.dispatch(req.method, params, { conn });
      } finally {
        done();
      }
      // A paired device gets what it may see of the answer (remote/policy.ts).
      if (conn.access !== "local") result = remoteResult(req.method, result, this.#o.policy());
      done = this.#core.scheduler.mark(name);
      try {
        reply({ result: result ?? null });
      } finally {
        done();
      }
    } catch (err) {
      if (err instanceof RemoteDenied) {
        this.#core.remote.audit("denied", conn.deviceId ?? null, `${String(req.method)}: ${err.message}`);
        reply({ error: { code: -32001, message: err.message } });
        return;
      }
      // Handlers throw plain Errors for expected failures (a closed pane, a bad
      // path); a TypeError and the like is a bug in the core: report it.
      if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError) {
        rpcLog.error(`${req.method} threw`, err);
        recordCrash({ process: "core", kind: `rpc ${req.method}`, message: `${err.name}: ${err.message}`, stack: err.stack ?? null, context: { build: this.#o.build ?? "" } });
      } else rpcLog.warn(`${req.method} failed: ${(err as Error).message}`);
      reply({ error: { code: err instanceof RpcError ? err.code : -32000, message: (err as Error).message } });
    }
  }

  /** What a widget connection may do (docs/28 §4, S6): identify itself, then query events within the policy. */
  #widgetCall(conn: Connection, method: Method, params: Record<string, unknown>): unknown {
    if (method === "widget.hello") {
      const id = this.#core.widgetTokens.check(String(params.token ?? ""));
      if (!id) throw new Error("unknown or expired widget token");
      this.#widgetConns.set(conn, id);
      // A package widget's process: from the next line on, the widget wire (after this answer goes out).
      if (id.attach) this.#hosted.set(conn, id.attach((line) => conn.send(line), () => conn.close()));
      const { attach: _taken, ...who } = id;
      return who;
    }
    const who = this.#widgetConns.get(conn);
    if (!who) throw new Error("say widget.hello first");
    if (method === "data.query") return widgetRead(who, params.query as DataQuery, (q) => this.#core.data.query(q));
    if (method === "stats.query") return widgetStats(who, params as unknown as StatQuery, (id) => this.#core.stats.info(this.#core.stats.def(id)).class, (q) => this.#core.stats.query(q));
    throw new Error(`widgets may only read events and stats (data.query, stats.query), not ${String(method)}`);
  }

  /** Stops listening and cuts every client; the socket file goes if it is still this core's. */
  async close(): Promise<void> {
    this.#closed = true;
    this.disconnectAll();
    if (this.#sockCheck) clearInterval(this.#sockCheck);
    const closed = Promise.all(this.#servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const s of this.#sockets) s.destroy();
    await closed;
    // Leave a socket file this core didn't create be (another process's, on the same path).
    try {
      if (this.#sockIno !== null && fs.statSync(this.#o.socketPath).ino === this.#sockIno) fs.unlinkSync(this.#o.socketPath);
    } catch {}
  }
}

/** Refuse to start if another core is alive on this socket; remove it if stale. */
async function removeStaleSocket(sock: string): Promise<void> {
  if (!fs.existsSync(sock)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const c = net.createConnection(sock);
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
  if (alive) throw new Error(`a core is already running on ${sock}`);
  fs.unlinkSync(sock);
}

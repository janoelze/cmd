// The PTY host: a small process that owns the terminals (PTY + headless xterm,
// local.ts) and serves them to the core over a Unix socket, so they keep running
// while the core restarts (new code, an update, a crash). The core is its only
// client; a core that says hello takes over from the previous one. It is kept
// small and changes rarely on purpose: the core checks HOST_PROTOCOL and replaces
// a host that speaks another version (its terminals are then resurrected, see
// restore.ts). Entry point: host-main.ts.
//
// Newline-delimited JSON. Core → host: { id?, m, p } (no id: no reply). Host →
// core: { id, r } or { id, e }, and events { ev: "data", t, d } / { ev: "exit", t, c }.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { lineSplitter } from "@cmd/protocol";
import { ipcPath, logger } from "@cmd/protocol/node";
import { LocalBackend, type LocalTerm } from "./local.ts";
import type { PtyFactory } from "./pty.ts";
import type { TermSpawn } from "./types.ts";

/** Bump on any change to the messages; a core never talks to a host of another version. */
export const HOST_PROTOCOL = 1;

export interface HostHello {
  protocol: number;
  instance: string;
  pid: number;
  /** Epoch ms. */
  startedAt: number;
  /** The code folder it runs from (a packaged runtime copy, or the repo): tells an old host from a new one. */
  root: string;
  terms: { id: string; pid: number; cols: number; rows: number }[];
}

const log = logger("ptyhost");
const STARTED_AT = Date.now();

export class PtyHost {
  readonly backend: LocalBackend;
  #server: net.Server | null = null;
  #owner: net.Socket | null = null;
  #idleMs: number;
  #onIdle: () => void;
  #idle: NodeJS.Timeout | undefined;

  /** onIdle: no core and no terminals for idleMs (the host process exits). */
  constructor(factory: PtyFactory, o: { idleMs?: number; onIdle?: () => void } = {}) {
    this.backend = new LocalBackend(factory);
    this.#idleMs = o.idleMs ?? 10_000;
    this.#onIdle = o.onIdle ?? (() => {});
  }

  async listen(socketPath: string): Promise<void> {
    const sock = ipcPath(socketPath);
    const isFile = sock === socketPath;
    if (isFile) {
      fs.mkdirSync(path.dirname(sock), { recursive: true });
      await removeStaleSocket(sock);
    }
    this.#server = net.createServer((c) => this.#serve(c));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(sock, () => resolve());
    });
    if (isFile) fs.chmodSync(sock, 0o600);
    this.#checkIdle();
  }

  #serve(conn: net.Socket): void {
    conn.setEncoding("utf8");
    conn.on("error", () => {});
    conn.on("close", () => {
      if (this.#owner !== conn) return;
      this.#owner = null;
      log.info("core disconnected", { terminals: this.backend.list().length });
      this.#checkIdle();
    });
    conn.on(
      "data",
      lineSplitter((line) => {
        if (!line.trim()) return;
        let msg: { id?: number; m: string; p?: Record<string, unknown> };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        let reply: { r: unknown } | { e: string };
        try {
          reply = { r: this.#handle(conn, msg.m, msg.p ?? {}) };
        } catch (err) {
          reply = { e: (err as Error).message };
        }
        if (msg.id === undefined) {
          const fail = (e: string) => log.warn(`${msg.m} failed: ${e}`);
          if ("e" in reply) fail(reply.e);
          else Promise.resolve(reply.r).catch((err: Error) => fail(err.message));
          return;
        }
        const id = msg.id;
        Promise.resolve("r" in reply ? reply.r : Promise.reject(new Error(reply.e))).then(
          (r) => send(conn, { id, r: r ?? null }),
          (err: Error) => send(conn, { id, e: err.message }),
        );
      }),
    );
  }

  #handle(conn: net.Socket, m: string, p: Record<string, unknown>): unknown {
    if (m === "hello") {
      if (this.#owner && this.#owner !== conn) {
        log.info("a new core took over");
        this.#owner.destroy();
      }
      this.#owner = conn;
      clearTimeout(this.#idle);
      const hello: HostHello = {
        protocol: HOST_PROTOCOL,
        instance: this.backend.instance,
        pid: process.pid,
        startedAt: STARTED_AT,
        root: path.resolve(import.meta.dirname, "../../../.."),
        terms: this.backend.list().map((t) => ({ id: t.id, pid: t.pid, cols: t.cols, rows: t.rows })),
      };
      log.info("core connected", { terminals: hello.terms.length });
      return hello;
    }
    if (conn !== this.#owner) throw new Error("say hello first");
    const term = (): LocalTerm => {
      const t = this.backend.get(String(p.id));
      if (!t) throw new Error(`no such terminal: ${String(p.id)}`);
      return t;
    };
    switch (m) {
      case "spawn": {
        const o = p as unknown as TermSpawn;
        if (this.backend.get(o.id)) throw new Error(`terminal exists: ${o.id}`);
        let t: LocalTerm;
        try {
          t = this.backend.spawn(o);
        } catch (err) {
          log.warn(`terminal ${o.id.slice(0, 8)} could not start: ${(err as Error).message}`, { shell: path.basename(o.shell), cwd: o.cwd });
          throw err;
        }
        const started = Date.now();
        log.info(`terminal ${o.id.slice(0, 8)} started`, { pid: t.pid, shell: path.basename(o.shell), restored: !!o.replay });
        t.onData((d) => this.#event({ ev: "data", t: t.id, d }));
        t.onExit((c) => {
          // Without a core attached, this line is the only trace of it.
          log.info(`terminal ${t.id.slice(0, 8)} exited`, { code: c, aliveMs: Date.now() - started, core: !!this.#owner });
          this.#event({ ev: "exit", t: t.id, c });
          setImmediate(() => this.#checkIdle());
        });
        return { pid: t.pid };
      }
      case "write":
        return term().write(String(p.data));
      case "resize":
        return term().resize(Number(p.cols), Number(p.rows));
      case "kill":
        return term().kill();
      case "process":
        return term().process();
      case "snapshot":
        return term().snapshot({ scrollback: Number(p.scrollback), restore: !!p.restore });
      case "read":
        return term().read(Number(p.lines));
      case "reset":
        return term().reset();
      case "shutdown":
        log.info("asked to shut down", { terminals: this.backend.list().length });
        this.backend.dispose();
        setImmediate(() => this.#onIdle());
        return null;
      default:
        throw new Error(`unknown method: ${m}`);
    }
  }

  #event(e: unknown): void {
    if (this.#owner) send(this.#owner, e);
  }

  #checkIdle(): void {
    clearTimeout(this.#idle);
    if (this.#owner || this.backend.list().length > 0) return;
    this.#idle = setTimeout(() => this.#onIdle(), this.#idleMs);
  }

  /** Stop: the core hears it was on purpose ("bye"), then the terminals end. */
  async close(): Promise<void> {
    clearTimeout(this.#idle);
    this.#event({ ev: "bye" });
    this.backend.dispose();
    this.#owner?.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }
}

function send(conn: net.Socket, msg: unknown): void {
  if (conn.writable) conn.write(JSON.stringify(msg) + "\n");
}

/** Refuse to start if another host answers on this socket; remove it if stale. */
async function removeStaleSocket(sock: string): Promise<void> {
  if (!fs.existsSync(sock)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const c = net.createConnection(sock);
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
  if (alive) throw new Error(`a PTY host is already running on ${sock}`);
  fs.unlinkSync(sock);
}

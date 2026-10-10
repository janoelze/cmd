// The core's side of the PTY host (host.ts): terminals that live in the host
// process and keep running while the core restarts. connectHost() finds the
// host of this instance, or starts one.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { lineSplitter } from "@cmd/protocol";
import { ipcPath, logDir, logger, recordCrash } from "@cmd/protocol/node";
import { HOST_PROTOCOL, type HostHello } from "./host.ts";
import type { Snapshot, Term, TermBackend, TermSpawn } from "./types.ts";

const log = logger("ptyhost");

class RemoteTerm implements Term {
  readonly id: string;
  pid: number;
  ready: Promise<void>;
  #host: RemoteBackend;
  data: ((d: string) => void)[] = [];
  exit: ((code: number | null) => void)[] = [];

  constructor(host: RemoteBackend, id: string, pid: number, ready: (t: RemoteTerm) => Promise<void>) {
    this.#host = host;
    this.id = id;
    this.pid = pid;
    this.ready = ready(this);
  }

  write(data: string): void {
    this.#host.notify("write", { id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    this.#host.notify("resize", { id: this.id, cols, rows });
  }

  kill(): void {
    this.#host.notify("kill", { id: this.id });
  }

  process(): Promise<string> {
    return this.#host.request("process", { id: this.id }) as Promise<string>;
  }

  /** Output received for this terminal and passed to onData listeners (UTF-16 units). */
  seq = 0;

  /**
   * The host says how much of its output came after the snapshot; counted back from what
   * arrived by its reply, that is our seq (an older host doesn't say: no seq).
   */
  snapshot(o: { scrollback: number; restore?: boolean }): Promise<Snapshot> {
    return this.#host.request("snapshot", { id: this.id, ...o }, (r) => {
      const { after, ...s } = r as Snapshot & { after?: number };
      return typeof after === "number" ? { ...s, seq: Math.max(0, this.seq - after) } : s;
    }) as Promise<Snapshot>;
  }

  deliver(d: string): void {
    if (this.data.length) this.seq += d.length;
    for (const fn of this.data) fn(d);
  }

  read(lines: number): Promise<string> {
    return this.#host.request("read", { id: this.id, lines }) as Promise<string>;
  }

  async reset(): Promise<void> {
    await this.#host.request("reset", { id: this.id });
  }

  onData(fn: (data: string) => void): void {
    this.data.push(fn);
  }

  onExit(fn: (exitCode: number | null) => void): void {
    this.exit.push(fn);
  }
}

export class RemoteBackend implements TermBackend {
  readonly instance: string;
  /** The host process (for logs and stopping it). */
  readonly pid: number;
  readonly hello: HostHello;
  #sock: net.Socket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #terms = new Map<string, RemoteTerm>();
  #attached: RemoteTerm[];
  #lost: (() => void)[] = [];
  #disposed = false;
  /** The host said it is stopping on purpose (not a crash). */
  #bye = false;
  /** The host said another core took it over. */
  #replaced = false;
  #onReplaced: (() => void)[] = [];

  private constructor(sock: net.Socket, hello: HostHello) {
    this.#sock = sock;
    this.instance = hello.instance;
    this.pid = hello.pid;
    this.hello = hello;
    this.#attached = hello.terms.map((t) => this.#add(new RemoteTerm(this, t.id, t.pid, () => Promise.resolve())));
  }

  /** Connect and say hello (taking the host over from a previous core). Rejects a host of another protocol, or whose code is gone. */
  static connect(socketPath: string): Promise<RemoteBackend> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(ipcPath(socketPath));
      sock.setEncoding("utf8");
      let backend: RemoteBackend | null = null;
      const early: string[] = [];
      sock.on(
        "data",
        lineSplitter((line) => {
          if (backend) return backend.#receive(line);
          // The hello reply comes first; events can only follow it.
          const msg = JSON.parse(line) as { id?: number; r?: HostHello; e?: string };
          if (msg.id !== 0) return void early.push(line);
          if (msg.e || !msg.r) return (sock.destroy(), reject(new Error(msg.e ?? "no hello")));
          if (msg.r.protocol !== HOST_PROTOCOL || hostCodeGone(msg.r.root)) {
            sock.destroy();
            return reject(new HostMismatch(msg.r));
          }
          backend = new RemoteBackend(sock, msg.r);
          for (const l of early) backend.#receive(l);
          resolve(backend);
        }),
      );
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.off("error", reject);
        sock.on("error", () => {});
        sock.write(JSON.stringify({ id: 0, m: "hello", p: { protocol: HOST_PROTOCOL } }) + "\n");
      });
      sock.on("close", () => {
        if (!backend) return reject(new Error("the PTY host closed the connection"));
        backend.#closed();
      });
    });
  }

  #add(t: RemoteTerm): RemoteTerm {
    this.#terms.set(t.id, t);
    t.onExit(() => this.#terms.get(t.id) === t && this.#terms.delete(t.id));
    return t;
  }

  spawn(o: TermSpawn): Term {
    return this.#add(
      new RemoteTerm(this, o.id, 0, async (t) => {
        try {
          const r = (await this.request("spawn", { ...o })) as { pid: number };
          t.pid = r.pid;
        } catch (err) {
          this.#retireIfCodeGone();
          throw err;
        }
      }),
    );
  }

  #retiring = false;

  /**
   * A host whose code folder went away while it ran (a dev checkout or worktree
   * removed) can't start shells any more: node-pty's helper went with it. Stop
   * it; the core hears "bye", starts a host from its own code and resurrects
   * the terminals (Core.#backendLost).
   */
  #retireIfCodeGone(): void {
    if (this.#retiring || !hostCodeGone(this.hello.root)) return;
    this.#retiring = true;
    log.warn(`the PTY host (pid ${this.pid}) runs from ${this.hello.root}, which is gone: replacing it`);
    try {
      process.kill(this.pid, "SIGTERM");
    } catch {}
  }

  attached(): Term[] {
    return this.#attached;
  }

  /** Called once when the connection drops without dispose(): the host died, and its terminals with it. */
  onLost(fn: () => void): void {
    this.#lost.push(fn);
  }

  onReplaced(fn: () => void): void {
    this.#onReplaced.push(fn);
  }

  /** `read` maps the reply as it arrives, before any message after it (a terminal's next output). */
  request(m: string, p: Record<string, unknown>, read?: (r: unknown) => unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (!this.#sock.writable) return reject(new Error("the PTY host is gone"));
      this.#pending.set(id, { resolve: read ? (r) => resolve(read(r)) : resolve, reject });
      this.#sock.write(JSON.stringify({ id, m, p }) + "\n");
    });
  }

  notify(m: string, p: Record<string, unknown>): void {
    if (this.#sock.writable) this.#sock.write(JSON.stringify({ m, p }) + "\n");
  }

  #receive(line: string): void {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as { id?: number; r?: unknown; e?: string; ev?: string; t?: string; d?: string; c?: number | null };
    if (msg.ev === "bye") {
      this.#bye = true;
    } else if (msg.ev === "replaced") {
      this.#replaced = true;
    } else if (msg.ev === "data") {
      const t = this.#terms.get(msg.t!);
      t?.deliver(msg.d!);
    } else if (msg.ev === "exit") {
      const t = this.#terms.get(msg.t!);
      if (t) for (const fn of [...t.exit]) fn(msg.c ?? null);
    } else if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.e !== undefined) p.reject(new Error(msg.e));
      else p.resolve(msg.r);
    }
  }

  #closed(): void {
    for (const p of this.#pending.values()) p.reject(new Error("the PTY host is gone"));
    this.#pending.clear();
    if (this.#disposed) return;
    this.#disposed = true;
    const n = this.#terms.size;
    if (this.#replaced) {
      log.warn(`another core took the PTY host (pid ${this.pid}) and its ${n} terminals over`);
      for (const fn of this.#onReplaced) fn();
      return;
    }
    if (this.#bye) log.warn(`the PTY host (pid ${this.pid}) was stopped, with ${n} terminals`);
    else {
      log.error(`lost the PTY host (pid ${this.pid}) and its ${n} terminals`);
      // Killed by a signal or a native crash, its own crash handler never ran: report it from here.
      recordCrash({ process: "ptyhost", kind: "exit", message: `PTY host died with ${n} terminals`, stack: null, log: tail(path.join(logDir(), "ptyhost.log"), 80) });
    }
    for (const fn of this.#lost) fn();
  }

  info(): { pid: number; startedAt: number; root: string } {
    return { pid: this.pid, startedAt: this.hello.startedAt, root: this.hello.root };
  }

  /** Stop the host; its terminals die. */
  async shutdownHost(): Promise<void> {
    await this.request("shutdown", {}).catch(() => {});
    this.dispose();
  }

  /** Let go: the host keeps the terminals running for the next core. */
  dispose(): void {
    this.#disposed = true;
    this.#sock.end();
  }
}

/**
 * Whether the folder a host runs from is gone (a removed worktree): it then
 * can't start shells, though the ones it has keep running.
 */
export function hostCodeGone(root: string | undefined): boolean {
  return !!root && !fs.existsSync(path.join(root, "packages/core/src/terminals/host-main.ts"));
}

/** A host this core can't use: another protocol, or its code is gone. */
export class HostMismatch extends Error {
  readonly hello: HostHello;
  constructor(hello: HostHello) {
    super(
      hello.protocol !== HOST_PROTOCOL
        ? `the PTY host (pid ${hello.pid}) speaks protocol ${hello.protocol}, this core ${HOST_PROTOCOL}`
        : `the PTY host (pid ${hello.pid}) runs from ${hello.root}, which is gone`,
    );
    this.hello = hello;
  }
}

/** Entry point of the host process. */
export const HOST_MAIN = path.join(import.meta.dirname, "host-main.ts");

export interface HostOptions {
  socketPath: string;
  /** --instance for the host (its logs and state dir). */
  instance: string;
  /** Where the host's stdout and stderr go (what bypasses its logger). */
  outputFile: string;
}

/**
 * The PTY host of this instance: connect, or start one and connect. A host of
 * another protocol, or run from a folder that is gone, is stopped first (its
 * terminals die; restore.ts resurrects them).
 */
export async function connectHost(o: HostOptions): Promise<RemoteBackend> {
  try {
    return attached(await RemoteBackend.connect(o.socketPath), false);
  } catch (err) {
    if (err instanceof HostMismatch) {
      log.warn(`${err.message}: replacing it`);
      try {
        process.kill(err.hello.pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 50 && (await answers(o.socketPath)); i++) await new Promise((r) => setTimeout(r, 100));
    }
  }
  startHost(o);
  let last: unknown;
  for (const until = Date.now() + 5000; Date.now() < until; ) {
    try {
      return attached(await RemoteBackend.connect(o.socketPath), true);
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  throw new Error(`the PTY host did not start: ${(last as Error)?.message ?? "no answer"}`);
}

function attached(b: RemoteBackend, started: boolean): RemoteBackend {
  const h = b.hello;
  log.info(started ? `using a new PTY host, pid ${h.pid}` : `using the running PTY host, pid ${h.pid}`, {
    terminals: h.terms.length,
    upMs: Date.now() - h.startedAt,
    root: h.root,
  });
  return b;
}

/** The last `n` lines of a log file. */
function tail(file: string, n: number): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function startHost(o: HostOptions): void {
  fs.mkdirSync(path.dirname(o.outputFile), { recursive: true });
  const fd = fs.openSync(o.outputFile, "a");
  const env = { ...process.env };
  // The packaged core is Electron running as Node; so is the host.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const child = spawn(process.execPath, ["--no-warnings", HOST_MAIN, `--instance=${o.instance}`], { detached: true, stdio: ["ignore", fd, fd], env });
  fs.closeSync(fd);
  log.debug(`started a PTY host, pid ${child.pid}`);
  child.unref();
}

function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(ipcPath(socketPath));
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
}

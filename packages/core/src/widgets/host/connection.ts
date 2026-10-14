// One package widget process's connection to the core (docs/56, "The runtime"): the widgets
// socket after its widget.hello (kernel/server.ts hands the connection over), carrying the
// widget wire of protocol widget-tree.ts, one JSON message a line. It parses what the process
// sends, sends what the core answers, and pings: a process that doesn't answer within the
// stall time (any line counts) has a stuck event loop, and its host stops it.

import type { WidgetIn, WidgetOut } from "@cmd/protocol";

const KINDS = new Set(["hello", "tree", "patch", "call", "subscribe", "unsubscribe", "log", "error"]);

export interface ConnectionTimes {
  /** How often the core pings (ms). */
  pingMs: number;
  /** No line for this long after a ping: stuck (ms). */
  stallMs: number;
}

export class HostConnection {
  #send: (line: string) => void;
  #close: () => void;
  #onMessage: (m: WidgetOut) => void;
  #onStall: () => void;
  #ping: NodeJS.Timeout | null = null;
  #pingedAt: number | null = null;
  #n = 0;
  #closed = false;

  constructor(send: (line: string) => void, close: () => void, o: { onMessage: (m: WidgetOut) => void; onStall: () => void; times: ConnectionTimes }) {
    this.#send = send;
    this.#close = close;
    this.#onMessage = o.onMessage;
    this.#onStall = o.onStall;
    this.#ping = setInterval(() => this.#tick(o.times), Math.min(o.times.pingMs, o.times.stallMs / 2));
    this.#ping.unref?.();
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(m: WidgetIn): void {
    if (!this.#closed) this.#send(JSON.stringify(m) + "\n");
  }

  /** A line from the process. */
  receive(line: string): void {
    this.#pingedAt = null;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m !== "object" || "pong" in m) return;
    if (!KINDS.has(String((m as { kind?: unknown }).kind))) return;
    this.#onMessage(m as WidgetOut);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ping) clearInterval(this.#ping);
    this.#close();
  }

  /** The socket went (the process exited or closed it). */
  ended(): void {
    this.#closed = true;
    if (this.#ping) clearInterval(this.#ping);
  }

  #tick(t: ConnectionTimes): void {
    if (this.#closed) return;
    const now = Date.now();
    if (this.#pingedAt !== null) {
      if (now - this.#pingedAt >= t.stallMs) this.#onStall();
      return;
    }
    this.#pingedAt = now;
    this.#send(JSON.stringify({ ping: ++this.#n }) + "\n");
  }
}

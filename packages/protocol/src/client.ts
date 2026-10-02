// Transport-agnostic JSON-RPC client. Node transport lives in ./node.ts.

import type { CoreEvent, Method, Params, Result, RpcMessage } from "./rpc.ts";

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class RpcClient {
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #listeners = new Set<(e: CoreEvent) => void>();
  #send: (line: string) => void;

  constructor(send: (line: string) => void) {
    this.#send = send;
  }

  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  onEvent(fn: (e: CoreEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Feed one complete line received from the transport. */
  receive(line: string): void {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as RpcMessage;
    if ("method" in msg && msg.method === "event") {
      const event = msg.params as CoreEvent;
      for (const fn of this.#listeners) fn(event);
      return;
    }
    if ("id" in msg) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if ("error" in msg && msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
      else p.resolve("result" in msg ? msg.result : null);
    }
  }

  /** Reject everything in flight, e.g. when the connection drops. */
  fail(err: Error): void {
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }
}

/** Splits a byte stream into lines. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  };
}

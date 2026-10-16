// The web client's connection to the Mac (connection.ts) as a state machine, with fake
// timers and a fake channel instead of a WebSocket and the Noise handshake: an attempt that
// hangs (iOS after a network change: the socket neither opens nor closes) is given up at
// the deadline and tried again; coming online or back in front drops a hung attempt at once;
// and a session that no longer answers is found out when the page comes back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTEMPT_MS, BACKOFF_VISIBLE_MS, Connection, PING_MS, type Opener } from "../src/connection.ts";
import type { Identity } from "../src/identity.ts";

/** One attempt: a socket that opens (or doesn't), and a session that answers (or doesn't). */
class Attempt {
  closedByUs = false;
  closeFns: ((e: { code: number }) => void)[] = [];
  #open!: (ok: boolean) => void;
  #session!: (s: unknown) => void;
  opened = new Promise<boolean>((r) => (this.#open = r));
  session = new Promise<unknown>((r) => (this.#session = r));
  /** The Mac stops answering (a half-open socket). */
  deaf = false;
  #line: (l: string) => void = () => {};
  ws = {
    addEventListener: (type: string, fn: (e: { code: number }) => void) => type === "close" && this.closeFns.push(fn),
    close: () => (this.closedByUs = true),
  };
  /** The socket opens and the handshake completes: the Mac answers core.hello and remote.bootstrap. */
  up(): void {
    this.#open(true);
    this.#session({
      send: (line: string) => {
        const m = JSON.parse(line) as { id: number; method: string };
        if (this.deaf) return;
        const result = m.method === "core.hello" ? { protocol: 1 } : m.method === "remote.bootstrap" ? { panes: [], agents: [], windows: [], workspaces: [], windowTypes: [], device: null, host: { name: "Mac" } } : null;
        queueMicrotask(() => this.#line(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })));
      },
      onLine: (fn: (l: string) => void) => (this.#line = fn),
    });
  }
}

const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden" });
const win = new EventTarget();
let attempts: Attempt[];
const opener = (() => {
  const a = new Attempt();
  attempts.push(a);
  a.session.catch(() => {});
  return a;
}) as unknown as Opener;
const id = { socket: "wss://relay", route: "r", hostKey: new Uint8Array(32), device: {}, deviceId: "d" } as unknown as Identity;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  attempts = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const online = (c: Connection) => c.phase.kind === "online";

describe("connecting to the Mac", () => {
  it("gives up on an attempt that hangs at the deadline, and tries again with backoff", async () => {
    const c = new Connection(id, opener);
    c.start();
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ATTEMPT_MS - 1);
    expect(attempts[0]!.closedByUs).toBe(false);
    expect(c.phase.kind).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts[0]!.closedByUs).toBe(true);
    expect(c.phase.kind).toBe("offline");
    // The first retry after 1 s; this one works.
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toHaveLength(2);
    attempts[1]!.up();
    await vi.advanceTimersByTimeAsync(0);
    expect(online(c)).toBe(true);
    // A late close from the abandoned socket changes nothing.
    attempts[0]!.closeFns.forEach((f) => f({ code: 1006 }));
    expect(online(c)).toBe(true);
    c.close();
  });

  it("waits at most 10 s between attempts while the page is in front", async () => {
    const c = new Connection(id, opener);
    c.start();
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(ATTEMPT_MS + BACKOFF_VISIBLE_MS);
    // 8 s deadline + at most 10 s apart: no fewer attempts than one per 18 s.
    expect(attempts.length).toBeGreaterThanOrEqual(8);
    c.close();
  });

  it("online during a hung attempt drops it and connects at once", async () => {
    const c = new Connection(id, opener);
    c.start();
    await vi.advanceTimersByTimeAsync(2000);
    win.dispatchEvent(new Event("online"));
    expect(attempts[0]!.closedByUs).toBe(true);
    expect(attempts).toHaveLength(2);
    attempts[1]!.up();
    await vi.advanceTimersByTimeAsync(0);
    expect(online(c)).toBe(true);
    c.close();
  });

  it("online right after an attempt began still drops it: it went out on the old network", async () => {
    const c = new Connection(id, opener);
    c.start();
    await vi.advanceTimersByTimeAsync(100);
    win.dispatchEvent(new Event("online"));
    expect(attempts[0]!.closedByUs).toBe(true);
    expect(attempts).toHaveLength(2);
    c.close();
  });

  it("coming back leaves an attempt it just made alone (visibilitychange then pageshow)", async () => {
    const c = new Connection(id, opener);
    c.start();
    await vi.advanceTimersByTimeAsync(3000);
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("pageshow"));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.closedByUs).toBe(false);
    c.close();
  });

  it("a session that stopped answering is found out when the page comes back, and replaced", async () => {
    const c = new Connection(id, opener);
    c.start();
    attempts[0]!.up();
    await vi.advanceTimersByTimeAsync(0);
    expect(online(c)).toBe(true);
    // Network changed while away: the socket looks open, nothing gets through.
    attempts[0]!.deaf = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(PING_MS - 1);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts[0]!.closedByUs).toBe(true);
    expect(attempts).toHaveLength(2);
    attempts[1]!.up();
    await vi.advanceTimersByTimeAsync(0);
    expect(online(c)).toBe(true);
    c.close();
  });

  it("a session that answers is kept", async () => {
    const c = new Connection(id, opener);
    c.start();
    attempts[0]!.up();
    await vi.advanceTimersByTimeAsync(0);
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(PING_MS * 2);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.closedByUs).toBe(false);
    expect(online(c)).toBe(true);
    c.close();
  });
});

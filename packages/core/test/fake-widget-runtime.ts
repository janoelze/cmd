// A fake widget runtime (widgets/host/runtime.ts) for the host's tests: each "process" is an
// object here that connects the way package-main.ts does (widget.hello with its token, which
// hands its connection to the host) and speaks the widget wire by hand, so a test can say
// hello, send a tree, freeze its event loop, crash or run out of memory on cue.
// Also: a package folder in a throwaway $CMD_WIDGETS_HOME, and a Core over it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WidgetIn, WidgetOut, WidgetPermissions } from "@cmd/protocol";
import type { WidgetTokens } from "../src/data/widgets.ts";
import type { ExitInfo, ProcessSpec, RuntimeProcess, WidgetRuntime } from "../src/widgets/host/runtime.ts";

export class FakeProcess implements RuntimeProcess {
  readonly pid = Math.floor(Math.random() * 90000) + 1000;
  readonly spec: ProcessSpec;
  /** What the core sent it (pings left out). */
  readonly received: WidgetIn[] = [];
  pings = 0;
  /** A stuck event loop: pings go unanswered. */
  frozen = false;
  killed = false;
  exited = false;
  #onExit: (e: ExitInfo) => void;
  #tokens: WidgetTokens;
  #conn: { receive(line: string): void; closed(): void } | null = null;
  #waiters: (() => void)[] = [];

  constructor(spec: ProcessSpec, onExit: (e: ExitInfo) => void, tokens: WidgetTokens) {
    this.spec = spec;
    this.#onExit = onExit;
    this.#tokens = tokens;
  }

  /** Connect and say widget.hello with its token, as package-main.ts does. */
  connect(): this {
    const id = this.#tokens.check(this.spec.token);
    if (!id?.attach) throw new Error("the token isn't a package widget's");
    this.#conn = id.attach(
      (line) => {
        const m = JSON.parse(line) as WidgetIn | { ping: number };
        if ("ping" in m) {
          this.pings++;
          if (!this.frozen) this.#conn?.receive(JSON.stringify({ pong: m.ping }));
          return;
        }
        this.received.push(m);
        for (const w of this.#waiters.splice(0)) w();
      },
      () => this.#end(),
    );
    return this;
  }

  send(m: WidgetOut): void {
    this.#conn?.receive(JSON.stringify(m));
  }

  hello(o: Partial<Extract<WidgetOut, { kind: "hello" }>> = {}): this {
    this.send({ kind: "hello", api: 1, minor: 0, package: this.spec.name, version: this.spec.version, widget: this.spec.widget, ...o });
    return this;
  }

  /** The messages of a kind it got. */
  got<K extends WidgetIn["kind"]>(kind: K): Extract<WidgetIn, { kind: K }>[] {
    return this.received.filter((m) => m.kind === kind) as Extract<WidgetIn, { kind: K }>[];
  }

  /** Waits until it got a message `test` accepts. */
  async next<K extends WidgetIn["kind"]>(kind: K, test: (m: Extract<WidgetIn, { kind: K }>) => boolean = () => true, ms = 3000): Promise<Extract<WidgetIn, { kind: K }>> {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.got(kind).find(test);
      if (m) return m;
      if (Date.now() > end) throw new Error(`no ${kind} came`);
      await new Promise<void>((r) => {
        this.#waiters.push(r);
        setTimeout(r, 20);
      });
    }
  }

  /** The process exits by itself. */
  crash(code = 1, stderr = ""): void {
    this.#conn?.closed();
    this.#exit({ code, signal: null, stderr });
  }

  kill(): void {
    this.killed = true;
    this.#conn?.closed();
    this.#exit({ code: null, signal: "SIGKILL", stderr: "" });
  }

  #end(): void {
    this.#conn = null;
  }

  #exit(e: ExitInfo): void {
    if (this.exited) return;
    this.exited = true;
    queueMicrotask(() => this.#onExit(e));
  }
}

export class FakeWidgetRuntime implements WidgetRuntime {
  readonly procs: FakeProcess[] = [];
  #tokens: WidgetTokens;
  /** What a new process does on its own (default: connect and say hello). */
  boot: (p: FakeProcess) => void = (p) => p.connect().hello();

  constructor(tokens: WidgetTokens) {
    this.#tokens = tokens;
  }

  start(spec: ProcessSpec, onExit: (e: ExitInfo) => void): RuntimeProcess {
    const p = new FakeProcess(spec, onExit, this.#tokens);
    this.procs.push(p);
    queueMicrotask(() => this.boot(p));
    return p;
  }

  get last(): FakeProcess {
    const p = this.procs.at(-1);
    if (!p) throw new Error("no process started");
    return p;
  }

  /** Processes that haven't exited. */
  alive(): FakeProcess[] {
    return this.procs.filter((p) => !p.exited);
  }
}

export interface FakePackage {
  name?: string;
  permissions?: Partial<WidgetPermissions>;
  config?: unknown[];
  api?: number;
}

/** A package folder "<name>" with one widget "main" in `home`. */
export function writePackage(home: string, o: FakePackage = {}): string {
  const name = o.name ?? "demo";
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const json = { name, version: "1.0.0", cmd: { api: o.api ?? 1, widgets: [{ id: "main", title: "Demo", main: "src/main.tsx", ...(o.config ? { config: o.config } : {}) }], permissions: o.permissions ?? {} } };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(json, null, 2));
  if (!fs.existsSync(path.join(dir, "src", "main.tsx"))) fs.writeFileSync(path.join(dir, "src", "main.tsx"), "export default function Main() { return null; }\n");
  return dir;
}

export const tmp = (prefix = "cmd-widget-host-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** Until `fn` holds (in-process waits: a host's timers). */
export async function until(fn: () => unknown, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

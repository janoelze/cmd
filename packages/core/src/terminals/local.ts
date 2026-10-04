// In-process terminals: each PTY mirrored into an @xterm/headless terminal.
// Used by tests, as the fallback without a PTY host, and inside the PTY host.

import { randomUUID } from "node:crypto";
import headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { Pty, PtyFactory } from "./pty.ts";
import type { Snapshot, Term, TermBackend, TermSpawn } from "./types.ts";

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;

export class LocalTerm implements Term {
  readonly id: string;
  readonly ready = Promise.resolve();
  #pty: Pty;
  /**
   * Fed with all output: the pane's real screen state. UIs that (re)attach get
   * it serialized (screen, scrollback, cursor, active modes) instead of a replay
   * of raw output, which duplicated TUI frames and could leave stale modes on.
   */
  #vt: HeadlessTerminal;
  #serializer = new SerializeAddon();
  #data: ((d: string) => void)[] = [];
  #exit: ((code: number | null) => void)[] = [];
  #exited = false;

  constructor(pty: Pty, o: TermSpawn) {
    this.id = o.id;
    this.#pty = pty;
    this.#vt = new headless.Terminal({ cols: o.cols, rows: o.rows, scrollback: o.scrollback, allowProposedApi: true });
    this.#vt.loadAddon(this.#serializer);
    // Character widths as the UI's terminals use them (emoji, CJK: two cells), so screens match.
    this.#vt.loadAddon(new Unicode11Addon());
    this.#vt.unicode.activeVersion = "11";
    if (o.replay) this.#vt.write(o.replay);
    pty.onData((d) => {
      this.#vt.write(d);
      for (const fn of this.#data) fn(d);
    });
    pty.onExit(({ exitCode }) => this.exited(exitCode));
  }

  get pid(): number {
    return this.#pty.pid;
  }

  get cols(): number {
    return this.#vt.cols;
  }

  get rows(): number {
    return this.#vt.rows;
  }

  write(data: string): void {
    this.#pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.#pty.resize(cols, rows);
    this.#vt.resize(cols, rows);
  }

  kill(): void {
    this.#pty.kill();
    // node-pty on Windows only reports the exit after asking a helper process for
    // the console's process list, which can take its 5 s timeout. The terminal is
    // gone for us now; node-pty finishes cleaning up in the background.
    if (process.platform === "win32") this.exited(null);
  }

  async process(): Promise<string> {
    return this.#pty.process;
  }

  async snapshot(o: { scrollback: number; restore?: boolean }): Promise<Snapshot> {
    await this.#flush();
    const vt = this.#vt;
    if (!o.restore) {
      // Cursor moves and wrapping in the data only replay right at the size they were made at.
      return { data: this.#serializer.serialize({ scrollback: o.scrollback }), cols: vt.cols, rows: vt.rows };
    }
    let data = this.#serializer.serialize({ scrollback: o.scrollback, excludeAltBuffer: true, excludeModes: true });
    // A program (an agent's input box) may have left the cursor above its last
    // lines; whatever comes next must go below them, not over them.
    const buf = vt.buffer.normal;
    const cursor = buf.baseY + buf.cursorY;
    let last = buf.length - 1;
    while (last > cursor && !buf.getLine(last)?.translateToString(true)) last--;
    if (last > cursor) data += "\r\n".repeat(last - cursor);
    return { data, cols: vt.cols, rows: vt.rows };
  }

  async read(lines: number): Promise<string> {
    await this.#flush();
    const buf = this.#vt.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
    while (out.length && !out.at(-1)) out.pop();
    return out.slice(-lines).join("\n");
  }

  async reset(): Promise<void> {
    await this.#flush();
    this.#vt.reset();
  }

  onData(fn: (data: string) => void): void {
    this.#data.push(fn);
  }

  onExit(fn: (exitCode: number | null) => void): void {
    this.#exit.push(fn);
  }

  /** Report the exit (once). Also called directly where node-pty reports it late (Windows). */
  exited(code: number | null): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const fn of this.#exit) fn(code);
    setTimeout(() => this.#vt.dispose(), 0);
  }

  /** Wait until all output written so far has been parsed. */
  #flush(): Promise<void> {
    return new Promise((resolve) => this.#vt.write("", resolve));
  }
}

export class LocalBackend implements TermBackend {
  /** Terminals die with this process: a new instance every time. */
  readonly instance = randomUUID();
  #factory: PtyFactory;
  #terms = new Map<string, LocalTerm>();

  constructor(factory: PtyFactory) {
    this.#factory = factory;
  }

  spawn(o: TermSpawn): LocalTerm {
    const t = new LocalTerm(this.#factory(o), o);
    this.#terms.set(o.id, t);
    t.onExit(() => this.#terms.get(o.id) === t && this.#terms.delete(o.id));
    return t;
  }

  attached(): Term[] {
    return [];
  }

  /** Terminals that are running. */
  list(): LocalTerm[] {
    return [...this.#terms.values()];
  }

  get(id: string): LocalTerm | undefined {
    return this.#terms.get(id);
  }

  dispose(): void {
    for (const t of this.#terms.values()) t.kill();
    this.#terms.clear();
  }
}

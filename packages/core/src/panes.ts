// Terminal sessions. The core owns the PTYs; UIs attach and detach freely.

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import type { Pane, PaneId, PaneUsage, Settings } from "@cmd/protocol";
import { usageChanged } from "./resources.ts";
import { DEFAULT_SETTINGS, ENV } from "@cmd/protocol";
import { OscScanner, stripAnsi, type OscEvent } from "./osc.ts";
import { classify, displayName, type Classification, type ForegroundInfo } from "./agents/procinfo.ts";
import { STATUS_ENV } from "./agents/statusfiles.ts";

/** What runs in the foreground of a pane's terminal. */
export interface Foreground {
  pid: number;
  /** unix ms; 0 if unknown */
  startedAt: number;
  name: string;
  class: Classification;
}

/** Looks up a terminal's foreground process from its shell pid (see ProcInfo). */
export type Inspector = (shellPid: number) => Promise<ForegroundInfo | null>;

/** The slice of node-pty we use, so tests can inject a fake. */
export interface Pty {
  readonly pid: number;
  /** Foreground process name. */
  readonly process: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(fn: (data: string) => void): void;
  onExit(fn: (e: { exitCode: number }) => void): void;
}

export interface SpawnOptions {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export type PtyFactory = (opts: SpawnOptions) => Pty;

export async function nodePtyFactory(): Promise<PtyFactory> {
  const pty = await import("node-pty");
  return (o) => {
    const p = pty.spawn(o.shell, o.args, {
      name: "xterm-256color",
      cols: o.cols,
      rows: o.rows,
      cwd: o.cwd,
      env: o.env,
    });
    return {
      get pid() {
        return p.pid;
      },
      get process() {
        return p.process;
      },
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      kill: (s) => p.kill(s),
      onData: (fn) => void p.onData(fn),
      onExit: (fn) => void p.onExit(fn),
    };
  };
}

const SCROLLBACK_BYTES = 512 * 1024;

interface Live {
  pane: Pane;
  pty: Pty;
  osc: OscScanner;
  buffer: string;
  /** Command to type once the shell is ready (see #scheduleCommand). */
  pending: { command: string; timer: NodeJS.Timeout | undefined; deadline: NodeJS.Timeout } | null;
  fg: Foreground | null;
  /** Secret the shell integration includes in its requests (OSC 777;cmd). */
  token: string;
}

/** zsh integration (shell/zsh): .zshenv restores the user's ZDOTDIR, then adds hooks. */
export const ZSH_INTEGRATION_DIR = path.resolve(import.meta.dirname, "../shell/zsh");

/** Shell counts as ready once its startup output has been quiet this long. */
const READY_QUIET_MS = 250;
/** Send anyway after this long, e.g. for a shell that prints nothing. */
const READY_MAX_MS = 4000;

export interface PaneEvents {
  output: [paneId: PaneId, data: string];
  updated: [pane: Pane];
  removed: [paneId: PaneId];
  osc: [paneId: PaneId, ev: OscEvent];
  foreground: [paneId: PaneId, fg: Foreground];
  /** A verified request from the pane's shell integration (e.g. `open .`). */
  request: [paneId: PaneId, action: string, arg: string];
}

export interface PaneManagerOptions {
  socketPath: string;
  /** Foreground poll interval; 0 disables polling (tests call pollForeground). */
  pollMs?: number;
  settings?: () => Settings;
  /** null: use node-pty's process name only (no argv, can't see through wrappers). */
  inspector?: Inspector | null;
}

export interface CreatePaneOptions {
  cwd?: string;
  command?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  id?: PaneId;
}

export class PaneManager extends EventEmitter<PaneEvents> {
  #panes = new Map<PaneId, Live>();
  #factory: PtyFactory;
  #socketPath: string;
  #settings: () => Settings;
  #inspector: Inspector | null;
  #poll: NodeJS.Timeout | undefined;
  #polling = false;

  constructor(factory: PtyFactory, o: PaneManagerOptions) {
    super();
    this.#factory = factory;
    this.#socketPath = o.socketPath;
    this.#settings = o.settings ?? (() => DEFAULT_SETTINGS);
    this.#inspector = o.inspector ?? null;
    const pollMs = o.pollMs ?? 500;
    if (pollMs > 0) {
      this.#poll = setInterval(() => this.pollForeground(), pollMs);
      this.#poll.unref();
    }
  }

  create(opts: CreatePaneOptions = {}): Pane {
    const id = opts.id ?? randomUUID();
    const cfg = this.#settings();
    const shell = cfg["shell.program"] || process.env.SHELL || "/bin/zsh";
    const cwd = opts.cwd ?? os.homedir();
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("ELECTRON_") && k !== "NODE_OPTIONS") env[k] = v;
    }
    const token = randomBytes(12).toString("hex");
    if (cfg["shell.integration"] && path.basename(shell) === "zsh" && fs.existsSync(ZSH_INTEGRATION_DIR)) {
      if (env.ZDOTDIR !== undefined) env.CMD_USER_ZDOTDIR = env.ZDOTDIR;
      env.ZDOTDIR = ZSH_INTEGRATION_DIR;
      env.CMD_PANE_TOKEN = token;
      env.CMD_OPEN_FOLDERS = cfg["shell.openFolders"] ? "1" : "0";
      env.CMD_OPEN_URLS = cfg["shell.openUrls"] ? "1" : "0";
      env.CMD_OPEN_FILES = cfg["shell.openFiles"] ? "1" : "0";
    }
    Object.assign(env, {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "cmd",
      [ENV.socket]: this.#socketPath,
      [ENV.paneId]: id,
      // Compatible with the installed ghostty-agents hook (see agents/statusfiles.ts).
      [STATUS_ENV]: id,
      ...opts.env,
    });

    const pty = this.#factory({ shell, args: cfg["shell.login"] ? ["-l"] : [], cwd, cols, rows, env });
    const now = Date.now();
    const pane: Pane = {
      id,
      title: shell.split("/").pop() ?? "shell",
      cwd,
      shell,
      pid: pty.pid,
      foreground: shell.split("/").pop() ?? "",
      cols,
      rows,
      createdAt: now,
      lastActivityAt: now,
      exitCode: null,
      agentId: null,
      usage: null,
    };
    const live: Live = { pane, pty, osc: new OscScanner(), buffer: "", pending: null, fg: null, token };
    this.#panes.set(id, live);

    pty.onData((data) => this.#onData(live, data));
    pty.onExit(({ exitCode }) => {
      this.#clearPending(live);
      pane.exitCode = exitCode;
      this.emit("updated", { ...pane });
      this.#panes.delete(id);
      this.emit("removed", id);
    });

    if (opts.command) this.#scheduleCommand(live, opts.command);
    this.emit("updated", { ...pane });
    return { ...pane };
  }

  /**
   * zsh discards typeahead while it starts up, so writing the command immediately
   * loses characters. Wait until startup output has settled (or an OSC 133 prompt
   * mark arrives), then type it.
   */
  #scheduleCommand(live: Live, command: string): void {
    const deadline = setTimeout(() => this.#flushPending(live), READY_MAX_MS);
    live.pending = { command, timer: undefined, deadline };
  }

  #flushPending(live: Live): void {
    const p = live.pending;
    if (!p) return;
    this.#clearPending(live);
    live.pty.write(p.command + "\r");
  }

  #clearPending(live: Live): void {
    if (!live.pending) return;
    clearTimeout(live.pending.timer);
    clearTimeout(live.pending.deadline);
    live.pending = null;
  }

  #onData(live: Live, data: string): void {
    if (live.pending) {
      clearTimeout(live.pending.timer);
      live.pending.timer = setTimeout(() => this.#flushPending(live), READY_QUIET_MS);
    }
    live.buffer += data;
    if (live.buffer.length > SCROLLBACK_BYTES) live.buffer = live.buffer.slice(-SCROLLBACK_BYTES);
    live.pane.lastActivityAt = Date.now();
    this.emit("output", live.pane.id, data);
    for (const ev of live.osc.feed(data)) {
      let changed = false;
      if (ev.type === "title" && ev.title !== live.pane.title) {
        live.pane.title = ev.title;
        changed = true;
      } else if (ev.type === "cwd" && ev.cwd !== live.pane.cwd) {
        live.pane.cwd = ev.cwd;
        changed = true;
      }
      if (changed) this.emit("updated", { ...live.pane });
      if (ev.type === "prompt" && (ev.mark === "B" || ev.mark === "A")) this.#flushPending(live);
      if (ev.type === "request") {
        // Only the pane's own shell knows the token; printed text can't forge requests.
        if (ev.token === live.token) this.emit("request", live.pane.id, ev.action, ev.arg);
        continue;
      }
      this.emit("osc", live.pane.id, ev);
    }
  }

  async pollForeground(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      await Promise.all([...this.#panes.values()].map((l) => this.#pollOne(l)));
    } finally {
      this.#polling = false;
    }
  }

  async #pollOne(live: Live): Promise<void> {
    let info: ForegroundInfo | null = null;
    if (this.#inspector) info = await this.#inspector(live.pty.pid);
    if (!info) {
      let name: string;
      try {
        name = live.pty.process;
      } catch {
        return;
      }
      if (!name) return;
      info = { pid: -1, startedAt: 0, path: name, argv: [name] };
    }
    if (!this.#panes.has(live.pane.id)) return; // closed while we were asking
    const c = classify(info);
    const fg: Foreground = { pid: info.pid, startedAt: info.startedAt, name: displayName(c, info), class: c };
    const prev = live.fg;
    const same = prev && prev.pid === fg.pid && prev.name === fg.name && prev.class.kind === fg.class.kind;
    if (same) return;
    live.fg = fg;
    live.pane.foreground = fg.name;
    this.emit("foreground", live.pane.id, fg);
    this.emit("updated", { ...live.pane });
  }

  /** Store a resource sample; broadcasts only when it changed noticeably. */
  setUsage(id: PaneId, usage: PaneUsage): void {
    const l = this.#panes.get(id);
    if (!l) return;
    const changed = usageChanged(l.pane.usage, usage);
    l.pane.usage = usage;
    if (changed) this.emit("updated", { ...l.pane });
  }

  foreground(id: PaneId): Foreground | null {
    return this.#panes.get(id)?.fg ?? null;
  }

  get(id: PaneId): Pane | null {
    const l = this.#panes.get(id);
    return l ? { ...l.pane } : null;
  }

  list(): Pane[] {
    return [...this.#panes.values()].map((l) => ({ ...l.pane }));
  }

  setAgent(id: PaneId, agentId: string | null): void {
    const l = this.#panes.get(id);
    if (!l || l.pane.agentId === agentId) return;
    l.pane.agentId = agentId;
    this.emit("updated", { ...l.pane });
  }

  write(id: PaneId, data: string): void {
    this.#must(id).pty.write(data);
  }

  resize(id: PaneId, cols: number, rows: number): void {
    const l = this.#must(id);
    if (cols < 2 || rows < 2) return;
    l.pane.cols = cols;
    l.pane.rows = rows;
    l.pty.resize(cols, rows);
  }

  kill(id: PaneId): void {
    this.#panes.get(id)?.pty.kill();
  }

  snapshot(id: PaneId): string {
    return this.#must(id).buffer;
  }

  read(id: PaneId, lines = 50): string {
    const text = stripAnsi(this.#must(id).buffer);
    return text.split("\n").slice(-lines).join("\n");
  }

  dispose(): void {
    clearInterval(this.#poll);
    for (const l of this.#panes.values()) {
      this.#clearPending(l);
      l.pty.kill();
    }
    this.#panes.clear();
  }

  #must(id: PaneId): Live {
    const l = this.#panes.get(id);
    if (!l) throw new Error(`no such pane: ${id}`);
    return l;
  }
}

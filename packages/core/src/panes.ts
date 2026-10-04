// Terminal sessions. The core owns the panes; UIs attach and detach freely.
// The terminals themselves (PTY + screen state) come from a TermBackend: in
// process, or the PTY host that keeps them running across core restarts. Each
// pane is recorded in the store (and its screen saved now and then) so it can be
// brought back after a restart (see restore.ts).

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { logger } from "@cmd/protocol/node";
import type { Attention, Pane, PaneId, PaneUsage, Progress, Settings, SpaceId } from "@cmd/protocol";
import { usageChanged } from "./resources.ts";
import { DEFAULT_SETTINGS, ENV, HOME_SPACE_ID } from "@cmd/protocol";
import { DEVICE_REPLIES, OscScanner, type OscEvent } from "./osc.ts";
import { classify, displayName, type Classification, type ForegroundInfo } from "./agents/procinfo.ts";
import { STATUS_ENV } from "./agents/statusfiles.ts";
import type { Store } from "./store.ts";
import { integrate, shellName } from "./shells.ts";
import { LocalBackend } from "./terminals/local.ts";
import type { PtyFactory } from "./terminals/pty.ts";
import type { Term, TermBackend } from "./terminals/types.ts";

export type { Pty, PtyFactory, SpawnOptions } from "./terminals/pty.ts";
export { nodePtyFactory } from "./terminals/pty.ts";

const log = logger("panes");

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

/** What the store keeps of a pane to reattach or resurrect it (see restore.ts). */
export interface PaneRecord {
  id: PaneId;
  spaceId: SpaceId;
  title: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: number;
  muted: boolean;
  attention: Attention | null;
  /** The command line running when last saved; null at the prompt. */
  command: string | null;
  /** The shell integration's request secret (in the shell's environment). */
  token: string;
  /** TermBackend.instance the terminal ran in. */
  host: string;
}

const isWindows = process.platform === "win32";

/**
 * Shell for new terminals when `shell.program` is empty. On Windows $SHELL is
 * ignored (under Git Bash it's an MSYS path native processes can't run):
 * PowerShell 7 if installed, else Windows PowerShell.
 */
export function defaultShell(): string {
  if (!isWindows) return process.env.SHELL || "/bin/zsh";
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d, "pwsh.exe"))) ? "pwsh.exe" : "powershell.exe";
}

export { shellName };

/**
 * Scrollback lines included when a UI re-attaches. The headless terminal keeps no
 * more than this (or restore.scrollback, if larger): each kept line of a wide
 * terminal costs a few KB in the PTY host.
 */
const SNAPSHOT_SCROLLBACK = 5000;
/** How often changed screens are saved for restoring after a restart. */
const SCREEN_SAVE_MS = 10_000;
/** A progress bar not updated for this long goes away (as in Ghostty and Windows Terminal). */
const PROGRESS_STALE_MS = 15_000;

interface Live {
  pane: Pane;
  term: Term;
  osc: OscScanner;
  /** Command to type once the shell is ready (see #scheduleCommand). */
  pending: { command: string; timer: NodeJS.Timeout | undefined; deadline: NodeJS.Timeout } | null;
  fg: Foreground | null;
  /** Secret the shell integration includes in its requests (OSC 777;cmd). */
  token: string;
  /** The command line running, as the shell integration reports it. */
  command: string | null;
  /** The record as last stored, to skip writes that change nothing. */
  saved: string;
  /** Output since the screen was last saved. */
  dirty: boolean;
  /** Hash of the screen as last saved, to skip writing an identical one. */
  screenHash: string;
  /** When the foreground process was last looked up, and whether output came since (see pollForeground). */
  polledAt: number;
  outputSincePoll: boolean;
  /** Clears a progress bar the program stopped updating (it may have crashed). */
  progressTimer: NodeJS.Timeout | null;
}

/** Panes without output since the last foreground check are checked this often. */
const QUIET_POLL_MS = 5000;

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
  /** null: use the terminal's process name only (no argv, can't see through wrappers). */
  inspector?: Inspector | null;
  /** Extra environment for shells with integration (e.g. what `open` should route to cmd). */
  shellEnv?: () => Record<string, string>;
  /**
   * Where the `open` rules are kept for running shells (see writeShellRules), so
   * settings changes reach them; null: shells keep the rules they started with.
   */
  rulesFile?: string | null;
  /** Where pane records and screens are kept for restoring; null: nowhere (tests). */
  store?: Store | null;
  /** Folder for each pane's own shell history (zsh and bash integration), kept for restoring; null: none. */
  historyDir?: string | null;
}

export interface CreatePaneOptions {
  /** Default: Home. The core resolves the Space before creating (see Placement). */
  spaceId?: SpaceId;
  cwd?: string;
  command?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  id?: PaneId;
  /** Restoring: the old pane's screen, shown above the new shell. */
  replay?: string;
  /** Restoring: what the old pane had. */
  restored?: Pick<PaneRecord, "title" | "createdAt" | "muted" | "attention">;
}

export class PaneManager extends EventEmitter<PaneEvents> {
  /** Remote devices sizing a pane to their screen, and the desktop's size to go back to. */
  #overrides = new Map<PaneId, { owner: object; desktop: { cols: number; rows: number } }>();
  #backend: TermBackend;
  #panes = new Map<PaneId, Live>();
  #socketPath: string;
  #settings: () => Settings;
  #inspector: Inspector | null;
  #shellEnv: () => Record<string, string>;
  #rulesFile: string | null;
  #store: Store | null;
  #historyDir: string | null;
  #poll: NodeJS.Timeout | undefined;
  #polling = false;
  #screens: NodeJS.Timeout | undefined;

  /** A PtyFactory runs terminals in this process (tests, no PTY host). */
  constructor(backend: TermBackend | PtyFactory, o: PaneManagerOptions) {
    super();
    this.#backend = typeof backend === "function" ? new LocalBackend(backend) : backend;
    this.#socketPath = o.socketPath;
    this.#settings = o.settings ?? (() => DEFAULT_SETTINGS);
    this.#inspector = o.inspector ?? null;
    this.#shellEnv = o.shellEnv ?? (() => ({}));
    this.#rulesFile = o.rulesFile ?? null;
    this.#store = o.store ?? null;
    this.#historyDir = o.historyDir ?? null;
    const pollMs = o.pollMs ?? 500;
    if (pollMs > 0) {
      this.#poll = setInterval(() => this.pollForeground(), pollMs);
      this.#poll.unref();
    }
    if (this.#store) {
      this.#screens = setInterval(() => void this.saveScreens(), SCREEN_SAVE_MS);
      this.#screens.unref();
    }
  }

  get backend(): TermBackend {
    return this.#backend;
  }

  /**
   * The backend's terminals died with it (the PTY host crashed): forget the panes
   * without a trace (no events, records kept), so restore.ts can resurrect them
   * under the same ids from `next`.
   */
  replaceBackend(next: TermBackend): void {
    for (const l of this.#panes.values()) this.#clearPending(l);
    this.#panes.clear();
    this.#backend.dispose();
    this.#backend = next;
  }

  /** What the shell integration's `open` hands to cmd, as CMD_OPEN_* variables. */
  #openRules(): Record<string, string> {
    const cfg = this.#settings();
    return {
      CMD_OPEN_FOLDERS: cfg["shell.openFolders"] ? "1" : "0",
      CMD_OPEN_URLS: cfg["shell.openUrls"] ? "1" : "0",
      CMD_OPEN_FILES: cfg["shell.openFiles"] ? "1" : "0",
      ...this.#shellEnv(),
    };
  }

  /** Rewrite the rules file; the shells' `open` reads it on every call. Atomic, so a shell never reads half a file. */
  writeShellRules(): void {
    if (!this.#rulesFile) return;
    const body = Object.entries(this.#openRules())
      .map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'\n`)
      .join("");
    fs.mkdirSync(path.dirname(this.#rulesFile), { recursive: true });
    const tmp = `${this.#rulesFile}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.#rulesFile);
  }

  create(opts: CreatePaneOptions = {}): Pane {
    const id = opts.id ?? randomUUID();
    const cfg = this.#settings();
    const shell = cfg["shell.program"] || defaultShell();
    const cwd = opts.cwd ?? os.homedir();
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // CMD_APP_VERSION is the app's, for this core's logs; a core started in the shell isn't that app.
      if (v !== undefined && !k.startsWith("ELECTRON_") && k !== "NODE_OPTIONS" && k !== "CMD_APP_VERSION") env[k] = v;
    }
    const token = randomBytes(12).toString("hex");
    // -l means "login shell" to POSIX shells; PowerShell and cmd.exe don't take it.
    const login = cfg["shell.login"] && !isWindows;
    let args = login ? ["-l"] : [];
    const integration = cfg["shell.integration"] ? integrate(shell, login, env) : null;
    if (integration) {
      args = integration.args;
      env.CMD_PANE_TOKEN = token;
      Object.assign(env, this.#openRules());
      if (this.#rulesFile) env.CMD_OPEN_RULES = this.#rulesFile;
      if (this.#historyDir && integration.kind !== "fish") {
        fs.mkdirSync(this.#historyDir, { recursive: true, mode: 0o700 });
        env.CMD_PANE_HISTFILE = this.#historyFile(id, integration.kind);
      }
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

    // The headless copy only needs what is ever read back from it: a UI's snapshot and the saved screen.
    const kept = Math.min(cfg["terminal.scrollback"], Math.max(SNAPSHOT_SCROLLBACK, cfg["restore.scrollback"]));
    const term = this.#backend.spawn({ id, shell, args, cwd, cols, rows, env, scrollback: kept, replay: opts.replay });
    const now = Date.now();
    const pane: Pane = {
      id,
      spaceId: opts.spaceId ?? HOME_SPACE_ID,
      title: opts.restored?.title ?? (shellName(shell) || "shell"),
      cwd,
      shell,
      pid: term.pid,
      foreground: shellName(shell),
      cols,
      rows,
      createdAt: opts.restored?.createdAt ?? now,
      lastActivityAt: now,
      exitCode: null,
      agentId: null,
      usage: null,
      attention: opts.restored?.attention ?? null,
      muted: opts.restored?.muted ?? false,
      sizedBy: null,
      progress: null,
    };
    const live = this.#attach(pane, term, token);
    log.info(`pane ${id.slice(0, 8)} ${opts.restored ? "restored" : "started"}`, { shell: shellName(shell), pid: term.pid, command: opts.command ? opts.command.split(" ")[0] : null });
    if (opts.command) this.#scheduleCommand(live, opts.command);
    this.#changed(live);
    // A UI that is already attached hasn't seen the restored screen.
    if (opts.replay) this.emit("output", id, opts.replay);
    return { ...pane };
  }

  /** Take over a terminal that kept running while the core restarted; `rec` is what the store knew of it. */
  adopt(term: Term, rec: PaneRecord | null): Pane {
    const shell = rec?.shell ?? (this.#settings()["shell.program"] || defaultShell());
    const now = Date.now();
    const pane: Pane = {
      id: term.id,
      spaceId: rec?.spaceId ?? HOME_SPACE_ID,
      title: rec?.title ?? (shellName(shell) || "shell"),
      cwd: rec?.cwd ?? os.homedir(),
      shell,
      pid: term.pid,
      foreground: shellName(shell),
      cols: rec?.cols ?? 100,
      rows: rec?.rows ?? 30,
      createdAt: rec?.createdAt ?? now,
      lastActivityAt: now,
      exitCode: null,
      agentId: null,
      usage: null,
      attention: rec?.attention ?? null,
      muted: rec?.muted ?? false,
      sizedBy: null,
      progress: null,
    };
    const live = this.#attach(pane, term, rec?.token ?? "");
    live.command = rec?.command ?? null;
    log.info(`pane ${term.id.slice(0, 8)} reattached`, { pid: term.pid });
    this.#changed(live);
    return { ...pane };
  }

  #attach(pane: Pane, term: Term, token: string): Live {
    const live: Live = { pane, term, osc: new OscScanner(), pending: null, fg: null, token, command: null, saved: "", dirty: true, screenHash: "", polledAt: 0, outputSincePoll: true, progressTimer: null };
    this.#panes.set(pane.id, live);
    term.onData((data) => this.#onData(live, data));
    term.onExit((code) => this.#exited(live, code));
    term.ready.then(
      () => {
        if (pane.pid === term.pid || this.#panes.get(pane.id) !== live) return;
        pane.pid = term.pid;
        this.#changed(live);
      },
      (err: Error) => {
        log.error(`pane ${pane.id.slice(0, 8)} could not start: ${err.message}`);
        this.#exited(live, null);
      },
    );
    return live;
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
    live.term.write(p.command + "\r");
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
    live.dirty = true;
    live.outputSincePoll = true;
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
      if (changed) this.#changed(live);
      if (ev.type === "prompt" && (ev.mark === "B" || ev.mark === "A")) this.#flushPending(live);
      // Back at the prompt: nothing runs any more.
      if (ev.type === "prompt" && (ev.mark === "D" || ev.mark === "A") && live.command !== null) {
        live.command = null;
        this.#persist(live);
      }
      if (ev.type === "progress") {
        this.#setProgress(live, ev.progress);
        continue;
      }
      // Back at the prompt: a bar left behind is stale.
      if (ev.type === "prompt" && ev.mark === "A" && live.pane.progress) this.#setProgress(live, null);
      if (ev.type === "query") {
        live.term.write(DEVICE_REPLIES[ev.query]);
        continue;
      }
      if (ev.type === "request") {
        // Only the pane's own shell knows the token; printed text can't forge requests.
        if (!live.token || ev.token !== live.token) continue;
        if (ev.action === "exec") {
          live.command = ev.arg.trim().slice(0, 4096) || null;
          this.#persist(live);
        } else this.emit("request", live.pane.id, ev.action, ev.arg);
        continue;
      }
      this.emit("osc", live.pane.id, ev);
    }
  }

  async pollForeground(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      // A program starting or ending prints something (the typed Enter's newline, the
      // next prompt): quiet panes are only checked now and then.
      const now = Date.now();
      const due = [...this.#panes.values()].filter((l) => l.outputSincePoll || now - l.polledAt >= QUIET_POLL_MS);
      for (const l of due) (l.polledAt = now), (l.outputSincePoll = false);
      await Promise.all(due.map((l) => this.#pollOne(l)));
    } finally {
      this.#polling = false;
    }
  }

  async #pollOne(live: Live): Promise<void> {
    if (!live.term.pid) return; // not started yet
    let info: ForegroundInfo | null = null;
    if (this.#inspector) info = await this.#inspector(live.term.pid);
    if (!info) {
      let name: string;
      try {
        name = await live.term.process();
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
    this.#changed(live);
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

  /** The command line running in the pane, if its shell integration reported one. */
  command(id: PaneId): string | null {
    return this.#panes.get(id)?.command ?? null;
  }

  get(id: PaneId): Pane | null {
    const l = this.#panes.get(id);
    return l ? { ...l.pane } : null;
  }

  list(): Pane[] {
    return [...this.#panes.values()].map((l) => ({ ...l.pane }));
  }

  setSpace(id: PaneId, spaceId: SpaceId): void {
    const l = this.#panes.get(id);
    if (!l || l.pane.spaceId === spaceId) return;
    l.pane.spaceId = spaceId;
    this.#changed(l);
  }

  setAgent(id: PaneId, agentId: string | null): void {
    const l = this.#panes.get(id);
    if (!l || l.pane.agentId === agentId) return;
    l.pane.agentId = agentId;
    this.#changed(l);
  }

  #setProgress(live: Live, p: Progress | null): void {
    if (live.progressTimer) clearTimeout(live.progressTimer), (live.progressTimer = null);
    // No value given: keep the last one (an error or pause keeps the bar where it was).
    const next = p && { ...p, value: p.value >= 0 ? p.value : (live.pane.progress?.value ?? 0) };
    if (next) live.progressTimer = setTimeout(() => this.#setProgress(live, null), PROGRESS_STALE_MS);
    const cur = live.pane.progress;
    if (cur?.state === next?.state && cur?.value === next?.value) return;
    live.pane.progress = next;
    this.#changed(live);
  }

  /** The attention marker (see notifications.ts); null clears it. */
  setAttention(id: PaneId, attention: Attention | null): void {
    const l = this.#panes.get(id);
    if (!l || (l.pane.attention === null && attention === null)) return;
    l.pane.attention = attention;
    this.#changed(l);
  }

  setMuted(id: PaneId, muted: boolean): void {
    const l = this.#panes.get(id);
    if (!l || l.pane.muted === muted) return;
    l.pane.muted = muted;
    this.#changed(l);
  }

  write(id: PaneId, data: string): void {
    this.#must(id).term.write(data);
  }

  /** The desktop's size. While a device holds an override it is kept for when that ends. */
  resize(id: PaneId, cols: number, rows: number): void {
    const l = this.#must(id);
    if (cols < 2 || rows < 2) return;
    const o = this.#overrides.get(id);
    if (o) {
      o.desktop = { cols, rows };
      return this.#persist(l);
    }
    this.#setSize(l, cols, rows);
    this.#persist(l);
  }

  /**
   * A remote device shows this terminal and sizes it to its screen (docs/13,
   * "Terminals on a phone"): one override per pane, the latest owner wins. The
   * desktop's own size comes back on release (the device leaves, locks or
   * disconnects, or someone types at the Mac).
   */
  override(id: PaneId, owner: object, label: string, cols: number, rows: number): void {
    const l = this.#must(id);
    const o = this.#overrides.get(id);
    this.#overrides.set(id, { owner, desktop: o?.desktop ?? { cols: l.pane.cols, rows: l.pane.rows } });
    const changed = l.pane.sizedBy !== label || l.pane.cols !== cols || l.pane.rows !== rows;
    l.pane.sizedBy = label;
    this.#setSize(l, cols, rows);
    if (changed) this.#changed(l);
  }

  /** End the override (only `owner`'s, if given): back to the desktop's size. */
  release(id: PaneId, owner?: object): void {
    const o = this.#overrides.get(id);
    const l = this.#panes.get(id);
    if (!o || (owner && o.owner !== owner)) return;
    this.#overrides.delete(id);
    if (!l) return;
    l.pane.sizedBy = null;
    this.#setSize(l, o.desktop.cols, o.desktop.rows);
    this.#changed(l);
  }

  /** Every override this owner holds (its connection closed). */
  releaseAll(owner: object): void {
    for (const [id, o] of this.#overrides) if (o.owner === owner) this.release(id, owner);
  }

  #setSize(l: Live, cols: number, rows: number): void {
    if (l.pane.cols === cols && l.pane.rows === rows) return;
    l.pane.cols = cols;
    l.pane.rows = rows;
    l.term.resize(cols, rows);
  }

  /** Clear stuck terminal state (modes a crashed program left on). */
  async resetState(id: PaneId): Promise<void> {
    await this.#must(id).term.reset();
  }

  kill(id: PaneId): void {
    this.#panes.get(id)?.term.kill();
  }

  #exited(live: Live, exitCode: number | null): void {
    const { pane } = live;
    if (this.#panes.get(pane.id) !== live) return; // already handled, or shutting down
    this.#clearPending(live);
    if (live.progressTimer) clearTimeout(live.progressTimer);
    pane.exitCode = exitCode;
    log.info(`pane ${pane.id.slice(0, 8)} exited`, { exitCode, agent: pane.agentId ? pane.agentId.slice(0, 8) : null, aliveMs: Date.now() - pane.createdAt });
    this.emit("updated", { ...pane });
    this.#panes.delete(pane.id);
    this.discard(pane.id);
    this.#overrides.delete(pane.id);
    this.emit("removed", pane.id);
  }

  /** The pane's own shell history (see shell/zsh, shell/bash), in that shell's format. */
  #historyFile(id: PaneId, shell: "zsh" | "bash"): string {
    return path.join(this.#historyDir!, `${id}.${shell}_history`);
  }

  /** Forget a pane for good: its record, screen and shell history. */
  discard(id: PaneId): void {
    this.#store?.deletePane(id);
    if (this.#historyDir) for (const sh of ["zsh", "bash"] as const) fs.rmSync(this.#historyFile(id, sh), { force: true });
  }

  /** Serialized terminal state for a UI to restore exactly what is on screen. */
  snapshot(id: PaneId): Promise<{ data: string; cols: number; rows: number }> {
    return this.#must(id).term.snapshot({ scrollback: SNAPSHOT_SCROLLBACK });
  }

  /** The last `lines` lines of text (screen + scrollback, as displayed). */
  read(id: PaneId, lines = 50): Promise<string> {
    return this.#must(id).term.read(lines);
  }

  /** Save the screens that changed since last time, for restoring after a restart. */
  async saveScreens(): Promise<void> {
    const store = this.#store;
    const lines = this.#settings()["restore.scrollback"];
    if (!store || lines <= 0) return;
    let bytes = 0;
    const dirty = [...this.#panes.values()].filter((l) => l.dirty);
    const changed: { l: Live; data: string; hash: string }[] = [];
    await Promise.all(
      dirty
        .map(async (l) => {
          l.dirty = false;
          try {
            const s = await l.term.snapshot({ scrollback: lines, restore: true });
            // Output doesn't always change the screen (a redraw, a cursor move back and forth).
            const hash = createHash("sha1").update(s.data).digest("base64");
            if (hash !== l.screenHash) changed.push({ l, data: s.data, hash });
          } catch (err) {
            l.dirty = true;
            log.warn(`could not save the screen of pane ${l.pane.id.slice(0, 8)}: ${(err as Error).message}`);
          }
        }),
    );
    if (!changed.length) return;
    store.transaction(() => {
      for (const { l, data, hash } of changed) {
        if (this.#panes.get(l.pane.id) !== l) continue;
        store.saveScreen(l.pane.id, data);
        l.screenHash = hash;
        bytes += data.length;
      }
    });
    log.debug(`saved ${changed.length} screens`, { kb: Math.round(bytes / 1024), unchanged: dirty.length - changed.length });
  }

  /** The pane as the store keeps it. */
  #record(l: Live): PaneRecord {
    const p = l.pane;
    // While a device sizes it, the desktop's size is the one worth keeping.
    const size = this.#overrides.get(p.id)?.desktop ?? p;
    return {
      id: p.id,
      spaceId: p.spaceId,
      title: p.title,
      cwd: p.cwd,
      shell: p.shell,
      cols: size.cols,
      rows: size.rows,
      createdAt: p.createdAt,
      muted: p.muted,
      attention: p.attention,
      command: l.command,
      token: l.token,
      host: this.#backend.instance,
    };
  }

  #persist(l: Live): void {
    if (!this.#store || this.#panes.get(l.pane.id) !== l) return;
    const rec = this.#record(l);
    const json = JSON.stringify(rec);
    if (json === l.saved) return;
    l.saved = json;
    this.#store.savePane(rec);
  }

  #changed(l: Live): void {
    this.#persist(l);
    this.emit("updated", { ...l.pane });
  }

  /**
   * The core is stopping: save the screens, then let go of the terminals (the
   * PTY host keeps them running; in-process ones die). Records stay for restore.
   */
  async shutdown(): Promise<void> {
    clearInterval(this.#screens);
    await this.saveScreens();
    this.dispose();
  }

  dispose(): void {
    clearInterval(this.#poll);
    clearInterval(this.#screens);
    for (const l of this.#panes.values()) this.#clearPending(l);
    this.#panes.clear();
    this.#backend.dispose();
  }

  #must(id: PaneId): Live {
    const l = this.#panes.get(id);
    if (!l) throw new Error(`no such pane: ${id}`);
    return l;
  }
}

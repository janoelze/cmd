// Workspace Actions in the core (docs/39): a catalog per folder someone is
// looking at, kept current by watching the folders its sources read; runs in
// terminals started from it, followed through their OSC 133 marks (running,
// exit status) and their output (a dev server's URL); ranking from the command
// log; the fast tier's descriptions, cached per folder; and pins.

import path from "node:path";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import type { ActionRun, ActionsList, Pane, PaneId, SpaceId, WorkspaceAction } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { WatchService } from "../watch.ts";
import type { PaneManager } from "../panes.ts";
import { scan, type Scan } from "./catalog.ts";
import { classify } from "./classify.ts";
import { rank, type Ran, type Ranked } from "./history.ts";
import { applyDescribed, describe, DescribedCache, inputOf, type DescribeAi, type Described } from "./describe.ts";

const log = logger("actions");

export interface ActionsOptions {
  panes: PaneManager;
  db: DatabaseSync | null;
  /** Commands run under a folder since a time, from the log; [] without one. */
  commands: (root: string, since: number) => Ran[];
  ai: (DescribeAi & { ready(): boolean }) | null;
  /** Settings: whether the model may describe, and folders to keep watching (open widgets). */
  describeOn: () => boolean;
  roots: () => string[];
  createPane: (o: { cwd: string; command: string; spaceId: SpaceId }) => Pane;
  /** How the person starts an agent (agents.<kind>.command), for its skills; null: the agent's name. */
  agentCommand?: (agent: string) => string | null;
  /** ms before a changed folder is read again, and before the model is asked. */
  debounce?: { scan: number; describe: number };
}

interface Catalog {
  root: string;
  scan: Scan;
  watched: string[];
  usedAt: number;
  scanTimer?: NodeJS.Timeout;
  ranked?: { at: number; r: Ranked };
  described: { hash: string; d: Described } | null;
  describing: boolean;
  describeTimer?: NodeJS.Timeout;
}

interface Tracked {
  root: string;
  run: ActionRun;
  command: string;
  /** The command's C mark was seen: its D (or a new prompt) ends the run. */
  started: boolean;
  /** Stopped to run again: when it ends, the command is typed again. */
  restart: boolean;
  /** The output's tail, for a URL split across chunks. */
  tail: string;
}

/** Ranking reads the log at most this often per folder. */
const RANK_TTL = 30_000;
/** A folder nobody shows is let go after this long. */
const IDLE = 120_000;
const HISTORY_DAYS = 90;

// CSI and OSC sequences, so "Local:   \e[1mhttp://localhost:\e[22m5173" reads as one URL.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;
// Followed by a space or the like: "http://localhost:" at the end of a chunk waits for its port.
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.local|[\w-]+\.localhost)(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?(?=[\s'"<>)\],;]|\.(?:\s|$))/;

export function findUrl(text: string): string | null {
  const m = LOCAL_URL.exec(text.replace(ANSI, ""));
  if (!m) return null;
  return m[0].replace(/[.,;:]+$/, "").replace("0.0.0.0", "localhost").replace(/\[::1?\]/, "localhost");
}

/** A source's file as listed: a folder of scripts once ("scripts/"), not each script. */
const sourceFile = (f: string) => (/^(scripts|bin|mise-tasks|\.mise-tasks|\.mise\/tasks|\.github\/workflows)\//.test(f) ? f.slice(0, f.lastIndexOf("/") + 1) : f);

export class ActionsService extends EventEmitter<{ changed: [root: string]; url: [paneId: PaneId, url: string] }> {
  #o: ActionsOptions;
  #catalogs = new Map<string, Catalog>();
  #watch = new WatchService();
  /** Runs by pane; a pane runs one action at a time. */
  #runs = new Map<PaneId, Tracked>();
  #cache: DescribedCache;
  #sweep: NodeJS.Timeout;

  constructor(o: ActionsOptions) {
    super();
    this.#o = o;
    this.#cache = new DescribedCache(o.db);
    o.db?.exec(`CREATE TABLE IF NOT EXISTS workspace_actions_pins (root TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (root, id))`);
    this.#watch.on("changed", (p) => {
      for (const c of this.#catalogs.values()) if (c.watched.includes(p)) this.#rescanSoon(c);
    });
    o.panes.on("osc", (id, ev) => {
      const t = this.#runs.get(id);
      if (!t || ev.type !== "prompt" || t.run.endedAt !== null) return;
      if (ev.mark === "C") t.started = true;
      else if (t.started && (ev.mark === "D" || ev.mark === "A")) this.#ended(id, t, ev.mark === "D" ? (ev.exitCode ?? null) : null);
    });
    o.panes.on("output", (id, data) => {
      const t = this.#runs.get(id);
      if (!t || t.run.url || t.run.endedAt !== null) return;
      t.tail = (t.tail + data).slice(-4000);
      const url = findUrl(t.tail);
      if (url) {
        t.run.url = url;
        this.emit("changed", t.root);
        this.emit("url", id, url);
      }
    });
    o.panes.on("removed", (id) => {
      const t = this.#runs.get(id);
      if (!t) return;
      this.#runs.delete(id);
      this.emit("changed", t.root);
    });
    this.#sweep = setInterval(() => this.#drop(), 60_000);
    this.#sweep.unref();
  }

  /** The folder's actions, read now if nobody was looking at it. */
  list(root: string): ActionsList {
    const c = this.#open(root);
    c.usedAt = Date.now();
    const describedOn = this.#o.describeOn();
    const d = describedOn ? (c.described?.d ?? null) : null;
    const ranked = this.#ranked(c);
    const pins = this.#pins(root);
    const pinned = new Set(pins.map((p) => p.id));
    const fileActions = applyDescribed(c.scan.actions, d);
    const fromFiles = new Set(fileActions.map((a) => a.id));
    // Pinned commands from history or the README stay even when no longer ranked.
    const extra = pins.filter((p) => !fromFiles.has(p.id));
    const order = new Map(fileActions.map((a, i) => [a.id, i]));
    const actions = [...fileActions, ...extra]
      .map((a) => ({ ...a, use: ranked.use.get(a.id) ?? a.use ?? 0, pinned: pinned.has(a.id) || undefined }))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.use ?? 0) - (a.use ?? 0) || (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    const commands = new Set(actions.map((a) => a.command));
    const suggested = (d?.suggested ?? [])
      .filter((s) => !commands.has(s.command))
      .map((s): WorkspaceAction => ({ id: `readme:${s.command}`, name: s.name, command: s.command, cwd: root, source: { kind: "readme", file: "README.md" }, ...classify({ name: s.name, command: s.command, cwd: root, file: "README.md" }), description: s.description, describedBy: "model" }));
    return {
      root,
      actions,
      history: ranked.history.filter((h) => !pinned.has(h.id) && !commands.has(h.command)),
      suggested: suggested.filter((s) => !pinned.has(s.id)),
      primary: this.#primary(actions, d),
      sources: [...new Set(c.scan.actions.map((a) => sourceFile(a.source.file)))].map((file): { file: string; error?: string } => ({ file })).concat(c.scan.errors),
      runs: [...this.#runs.values()].filter((t) => t.root === root).map((t) => ({ ...t.run })),
      describing: describedOn && c.describing,
    };
  }

  /**
   * Run an action: in its terminal if that is back at its prompt (or, for a
   * server still running, just say which pane it is), else in a new one.
   * `restart`: stop it first (⌃C) and run it again when it has stopped.
   */
  run(root: string, actionId: string, spaceId: SpaceId, o: { restart?: boolean; fresh?: boolean } = {}): { paneId: PaneId; started: boolean } {
    const list = this.list(root);
    const found = [...list.actions, ...list.history, ...list.suggested].find((x) => x.id === actionId);
    if (!found) throw new Error(`no action ${actionId} in ${root}`);
    // An agent skill starts the agent the way the person has set it up ("claude --model opus /triage").
    const own = found.agent ? this.#o.agentCommand?.(found.agent) : null;
    const a = own ? { ...found, command: found.command.replace(/^\S+/, () => own) } : found;
    const prev = o.fresh ? undefined : [...this.#runs.entries()].filter(([, t]) => t.root === root && t.run.actionId === actionId).sort((x, y) => y[1].run.startedAt - x[1].run.startedAt)[0];
    if (prev && this.#o.panes.get(prev[0])) {
      const [paneId, t] = prev;
      if (t.run.endedAt === null) {
        if (!o.restart) return { paneId, started: false };
        t.restart = true;
        this.#o.panes.write(paneId, "\x03");
        return { paneId, started: true };
      }
      if (this.#o.panes.command(paneId) === null) {
        this.#track(paneId, root, a);
        this.#o.panes.write(paneId, a.command + "\r");
        return { paneId, started: true };
      }
    }
    const pane = this.#o.createPane({ cwd: a.cwd, command: a.command, spaceId });
    this.#track(pane.id, root, a);
    return { paneId: pane.id, started: true };
  }

  /** ⌃C to the action's running terminal. */
  stop(root: string, actionId: string): void {
    for (const [paneId, t] of this.#runs) if (t.root === root && t.run.actionId === actionId && t.run.endedAt === null) this.#o.panes.write(paneId, "\x03");
  }

  /** Pin (or unpin) an action of this folder; a command from history or the README is saved as one. */
  pin(root: string, actionId: string, pinned: boolean): void {
    if (!pinned) this.#o.db?.prepare(`DELETE FROM workspace_actions_pins WHERE root = ? AND id = ?`).run(root, actionId);
    else {
      const list = this.list(root);
      const a = [...list.actions, ...list.history, ...list.suggested].find((x) => x.id === actionId);
      if (!a) throw new Error(`no action ${actionId} in ${root}`);
      const { use: _use, pinned: _p, ...keep } = a;
      this.#o.db?.prepare(`INSERT OR REPLACE INTO workspace_actions_pins (root, id, json, at) VALUES (?, ?, ?, ?)`).run(root, actionId, JSON.stringify(keep), Date.now());
    }
    this.emit("changed", root);
  }

  /** Read the folder again now (tests, a manual refresh). */
  refresh(root: string): void {
    const c = this.#catalogs.get(root);
    if (c) this.#rescan(c);
  }

  /** The settings or the AI provider changed: describe what's open, or stop showing the model's words. */
  aiChanged(): void {
    for (const c of this.#catalogs.values()) {
      this.#describeSoon(c);
      this.emit("changed", c.root);
    }
  }

  dispose(): void {
    clearInterval(this.#sweep);
    for (const c of this.#catalogs.values()) {
      clearTimeout(c.scanTimer);
      clearTimeout(c.describeTimer);
    }
    this.#catalogs.clear();
    this.#watch.close();
  }

  #open(root: string): Catalog {
    let c = this.#catalogs.get(root);
    if (c) return c;
    const started = performance.now();
    const s = scan(root, null);
    const ms = performance.now() - started;
    if (ms > 50) log.warn(`reading ${root} took ${ms.toFixed(0)} ms`);
    const cached = this.#cache.get(root);
    c = { root, scan: s, watched: [], usedAt: Date.now(), described: cached ? { hash: cached.hash, d: cached.described } : null, describing: false };
    this.#catalogs.set(root, c);
    this.#rewatch(c);
    this.#describeSoon(c);
    return c;
  }

  #rescanSoon(c: Catalog): void {
    clearTimeout(c.scanTimer);
    c.scanTimer = setTimeout(() => this.#rescan(c), this.#o.debounce?.scan ?? 300);
    c.scanTimer.unref();
  }

  #rescan(c: Catalog): void {
    if (this.#catalogs.get(c.root) !== c) return;
    const next = scan(c.root, c.scan);
    const same = JSON.stringify(next.actions) === JSON.stringify(c.scan.actions) && JSON.stringify(next.errors) === JSON.stringify(c.scan.errors);
    c.scan = next;
    this.#rewatch(c);
    if (same) return;
    c.ranked = undefined;
    this.#describeSoon(c);
    this.emit("changed", c.root);
  }

  #rewatch(c: Catalog): void {
    const next = c.scan.folders;
    for (const p of c.watched) if (!next.includes(p)) this.#watch.unwatch(p);
    for (const p of next) if (!c.watched.includes(p)) this.#watch.watch(p);
    c.watched = next;
  }

  #ranked(c: Catalog): Ranked {
    const now = Date.now();
    if (c.ranked && now - c.ranked.at < RANK_TTL) return c.ranked.r;
    let r: Ranked;
    try {
      r = rank(c.scan.actions, this.#o.commands(c.root, now - HISTORY_DAYS * 86400_000), c.root, now);
    } catch (e) {
      log.warn(`ranking ${c.root}: ${(e as Error).message}`);
      r = { use: new Map(), history: [] };
    }
    c.ranked = { at: now, r };
    return r;
  }

  #primary(actions: WorkspaceAction[], d: Described | null): string | null {
    if (d?.primary && actions.some((a) => a.id === d.primary)) return d.primary;
    const root = actions.filter((a) => !a.hidden && !a.package && !a.history);
    for (const name of ["dev", "start", "serve", "up"]) {
      const a = root.find((x) => x.name === name && x.kind === "dev");
      if (a) return a.id;
    }
    return root.find((a) => a.kind === "dev" && a.long)?.id ?? null;
  }

  #describeSoon(c: Catalog): void {
    clearTimeout(c.describeTimer);
    const ai = this.#o.ai;
    if (!ai?.ready() || !this.#o.describeOn() || c.scan.actions.length === 0) return;
    if (c.described?.hash === inputOf(c.root, c.scan.actions).hash) return;
    c.describeTimer = setTimeout(() => void this.#describe(c, ai), this.#o.debounce?.describe ?? 2000);
    c.describeTimer.unref();
  }

  async #describe(c: Catalog, ai: DescribeAi): Promise<void> {
    if (c.describing) return void this.#describeSoon(c);
    const input = inputOf(c.root, c.scan.actions);
    if (c.described?.hash === input.hash) return;
    c.describing = true;
    this.emit("changed", c.root);
    try {
      const d = await describe(ai, c.root, c.scan.actions, input);
      c.described = { hash: input.hash, d };
      this.#cache.set(c.root, input.hash, d);
    } catch (e) {
      log.warn(`describing ${c.root}: ${(e as Error).message}`);
    } finally {
      c.describing = false;
      if (this.#catalogs.get(c.root) === c) this.emit("changed", c.root);
    }
    // The files changed while the model was answering.
    if (this.#catalogs.get(c.root) === c && inputOf(c.root, c.scan.actions).hash !== input.hash) this.#describeSoon(c);
  }

  #pins(root: string): WorkspaceAction[] {
    const rows = (this.#o.db?.prepare(`SELECT json FROM workspace_actions_pins WHERE root = ? ORDER BY at`).all(root) ?? []) as { json: string }[];
    const out: WorkspaceAction[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.json) as WorkspaceAction);
      } catch {}
    }
    return out;
  }

  #track(paneId: PaneId, root: string, a: WorkspaceAction): void {
    this.#runs.set(paneId, { root, command: a.command, started: false, restart: false, tail: "", run: { actionId: a.id, paneId, startedAt: Date.now(), endedAt: null, exitCode: null, url: null } });
    const c = this.#catalogs.get(root);
    if (c) c.ranked = undefined;
    this.emit("changed", root);
  }

  #ended(paneId: PaneId, t: Tracked, exitCode: number | null): void {
    t.run.endedAt = Date.now();
    t.run.exitCode = exitCode;
    const c = this.#catalogs.get(t.root);
    if (c) c.ranked = undefined;
    if (t.restart) {
      const next = { ...t, started: false, restart: false, tail: "", run: { ...t.run, startedAt: Date.now(), endedAt: null, exitCode: null, url: null } };
      this.#runs.set(paneId, next);
      this.#o.panes.write(paneId, t.command + "\r");
    }
    this.emit("changed", t.root);
  }

  /** Let go of folders nobody shows or asked about lately. */
  #drop(): void {
    const keep = new Set(this.#o.roots().map((r) => path.resolve(r)));
    const now = Date.now();
    for (const c of [...this.#catalogs.values()]) {
      if (keep.has(c.root) || now - c.usedAt < IDLE) continue;
      clearTimeout(c.scanTimer);
      clearTimeout(c.describeTimer);
      for (const p of c.watched) this.#watch.unwatch(p);
      this.#catalogs.delete(c.root);
    }
  }
}

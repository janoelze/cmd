// Agent tree. Combines foreground-process detection, hooks and OSC notifications
// into one state per agent, and implements the host API (spawn/send/wait/kill).
// Hook events are taken from the hook's spool into the activity log and reduced
// to state and turns (activity/); the per-event status files are the fallback
// for hooks that don't spool (the fork's). See docs/05-agent-integration.md,
// docs/08-host-agents.md and docs/18-agent-activity.md.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ActivityEvent, Agent, AgentId, AgentKind, AgentState, AgentTurn, Methods, PaneId, Settings, SpaceId } from "@cmd/protocol";
import { DEFAULT_SETTINGS, ENV, HOME_SPACE_ID } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { Foreground, PaneManager } from "../panes.ts";
import type { Store } from "../store.ts";
import { shq } from "../shell.ts";
import { registerBuiltinSources } from "../search/builtin.ts";
import { locateContext, TranscriptSources } from "../search/sources.ts";
import { briefing, checkoutOf } from "./peers.ts";
import { nativeSession, type StateChange } from "./state.ts";
import { readStatus, removeStatus, StatusWatcher, type HookStatus } from "./statusfiles.ts";
import { watchTurn, type TurnWatch } from "./activity/fswatch.ts";
import { changedBetween, snapshot, type GitSnapshot } from "./activity/gitsnap.ts";
import { ActivityLog } from "./activity/log.ts";
import type { RawEvent } from "./activity/normalize.ts";
import { ActivityReducer, addFile, type Reduction } from "./activity/reduce.ts";
import { drainSpool } from "./activity/spool.ts";

const log = logger("agents");

export interface TrackerOptions {
  store?: Store | null;
  settings?: () => Settings;
  /** Hook status directory to watch (statusRoot()); null disables. */
  statusRoot?: string | null;
  /** Also read this one (legacyStatusRoot(): the fork's hook), after statusRoot. */
  legacyStatusRoot?: string | null;
  /** A launched agent whose process never shows up within this time is dropped. */
  startTimeoutMs?: number;
  /** How to resume past sessions per agent (default: the built-ins). */
  sources?: TranscriptSources;
  /** Where events and turns are kept (default: in memory). */
  activity?: ActivityLog;
  /** Snapshot the work tree with git at each turn's start and end (files changed). */
  git?: boolean;
}

export interface TrackerEvents {
  updated: [agent: Agent];
  /** Brought back from the store (restore()), just before its "updated": its state is old news. */
  restored: [agent: Agent];
  removed: [agentId: AgentId];
  /** An event was recorded (activity log). */
  activity: [event: ActivityEvent];
  /** A hook said where the agent keeps its config ($CLAUDE_CONFIG_DIR, …). */
  home: [agent: AgentKind, dir: string];
  /** A session's transcript, at its start (its folder tells the home when the env didn't). */
  transcript: [agent: AgentKind, path: string];
}

type SpawnParams = Methods["agent.spawn"]["params"];

export class AgentTracker extends EventEmitter<TrackerEvents> {
  #agents = new Map<AgentId, Agent>();
  /** Agents for which a hook has reported; OSC notifications are only a fallback. */
  #hooked = new Set<AgentId>();
  /** Per agent, the peers it was last briefed about (peerBriefing). */
  #told = new Map<AgentId, string>();
  /** Spawned agents whose process has been seen; until then a shell foreground is expected. */
  #started = new Set<AgentId>();
  #panes: PaneManager;
  #store: Store | null;
  #settings: () => Settings;
  #statusRoot: string | null;
  #statusRoots: string[];
  #startTimeoutMs: number;
  #sources: TranscriptSources;
  #watchers: StatusWatcher[] = [];
  #backstop: NodeJS.Timeout | undefined;
  readonly activity: ActivityLog;
  /** Per agent whose events arrive through the spool: state and turns. */
  #reducers = new Map<AgentId, ActivityReducer>();
  #git: boolean;
  /** "Before" snapshots of open turns (or a folder watch outside git), by agent id + turn index. */
  #snaps = new Map<string, { git: Promise<GitSnapshot | null>; watch: TurnWatch | null }>();

  constructor(panes: PaneManager, o: TrackerOptions = {}) {
    super();
    this.#panes = panes;
    this.#store = o.store ?? null;
    this.#settings = o.settings ?? (() => DEFAULT_SETTINGS);
    this.#statusRoot = o.statusRoot ?? null;
    this.#statusRoots = this.#statusRoot ? [this.#statusRoot, ...(o.legacyStatusRoot ? [o.legacyStatusRoot] : [])] : [];
    this.#startTimeoutMs = o.startTimeoutMs ?? 15_000;
    this.#sources = o.sources ?? registerBuiltinSources(new TranscriptSources());
    this.activity = o.activity ?? new ActivityLog();
    this.#git = o.git ?? false;
    if (this.#statusRoot) {
      for (const root of this.#statusRoots) {
        const w = new StatusWatcher(root);
        w.on("changed", (paneId) => this.applyStatus(paneId));
        w.start();
        this.#watchers.push(w);
      }
      // FSEvents can drop events; re-read agent panes periodically as a backstop.
      this.#backstop = setInterval(() => this.tick(), 2000);
      this.#backstop.unref();
    }
    panes.on("foreground", (paneId, fg) => this.#onForeground(paneId, fg));
    panes.on("removed", (paneId) => {
      if (this.#statusRoot) this.#ingest(paneId, this.#drain(paneId), this.#byPane(paneId) ?? null);
      this.#onPaneRemoved(paneId);
      for (const root of this.#statusRoots) removeStatus(paneId, root);
    });
    panes.on("osc", (paneId, ev) => {
      if (ev.type !== "notify") return;
      const agent = this.#byPane(paneId);
      if (!agent || this.#hooked.has(agent.id)) return;
      this.#update(agent, { state: "needs_input", detail: ev.body || ev.title || "Needs attention" });
    });
  }

  list(): Agent[] {
    return [...this.#agents.values()].map((a) => ({ ...a }));
  }

  get(id: AgentId): Agent | null {
    const a = this.#agents.get(id);
    return a ? { ...a } : null;
  }

  /**
   * Context for a hook to hand the agent (`agents.peers`): the other live agents in
   * its repository. Always at SessionStart, then on a prompt only if they changed.
   */
  peerBriefing(id: AgentId, event: string): string | null {
    if (!this.#settings()["agents.peers"]) return null;
    if (event !== "SessionStart" && event !== "UserPromptSubmit") return null;
    const self = this.#agents.get(id);
    const at = self && this.#checkout(self);
    if (!self || !at) return null;
    const peers = [...this.#agents.values()]
      .filter((a) => a.id !== id && a.paneId && a.state !== "exited")
      .map((agent) => ({ agent, at: this.#checkout(agent) }))
      .filter((p): p is { agent: Agent; at: NonNullable<typeof at> } => p.at?.repo === at.repo);
    const key = peers.map((p) => p.agent.id).sort().join(",");
    if (event === "UserPromptSubmit" && key === (this.#told.get(id) ?? "")) return null;
    this.#told.set(id, key);
    return briefing({ agent: self, at }, peers) ?? (event === "SessionStart" ? null : "[cmd] The other agents in this repository have finished; none are working in parallel with you now.");
  }

  #checkout(a: Agent) {
    return checkoutOf(a.cwd || (a.paneId && this.#panes.get(a.paneId)?.cwd) || "");
  }

  // ── detection ──────────────────────────────────────────────

  close(): void {
    clearInterval(this.#backstop);
    for (const w of this.#watchers) w.close();
  }

  #onForeground(paneId: PaneId, fg: Foreground): void {
    const current = this.#byPane(paneId);
    if (fg.class.kind === "agent") {
      if (current) {
        this.#started.add(current.id);
        if (current.state === "starting") this.#update(current, { state: "idle" });
      } else {
        const a = this.#create({ kind: fg.class.agent, paneId, source: "detected" });
        this.#started.add(a.id);
      }
      this.applyStatus(paneId);
      return;
    }
    // The agent process is gone: back at the shell, or something else took over.
    if (current && this.#started.has(current.id)) {
      this.#exit(current);
      return;
    }
    // An unknown process that reports through hooks is an agent too.
    if (!current && fg.class.kind === "other") this.applyStatus(paneId);
  }

  /**
   * Takes a pane's new hook events (spool) into the log and its agent's state.
   * Panes whose hook doesn't spool (the fork's) fall back to the status files.
   */
  applyStatus(paneId: PaneId): void {
    if (!this.#statusRoot || !this.#panes.get(paneId)) return;
    const fresh = this.#drain(paneId);
    const fg = this.#panes.foreground(paneId);
    let agent = this.#byPane(paneId);
    if (!agent && fresh.length && fg?.class.kind === "other") {
      // An unknown process that reports through hooks is an agent too.
      const kind = fresh.find((e) => e.raw.agent)?.raw.agent;
      if (kind) {
        agent = this.#create({ kind, paneId, source: "detected" });
        this.#started.add(agent.id);
      }
    }
    if (agent && (this.#ingest(paneId, fresh, agent) || this.#reducers.has(agent.id))) return;
    if (!agent) this.#ingest(paneId, fresh, null);
    this.#applyStatusFiles(paneId);
  }

  /** Every 2 s: spooled events FSEvents didn't report, and agents that went quiet mid-turn. */
  tick(now = Date.now()): void {
    for (const a of [...this.#agents.values()]) {
      if (!a.paneId) continue;
      this.applyStatus(a.paneId);
      const red = this.#reducers.get(a.id);
      const pane = this.#panes.get(a.paneId);
      const r = red && pane ? red.tick(now, pane.lastActivityAt) : null;
      if (!r) continue;
      const ev = this.activity.note("interrupt", red!.turn?.inferred.at(-1) ?? "interrupted", now, a.paneId, a.id, a.kind);
      this.emit("activity", ev);
      this.#applyReduction(a, red!, r, ev, false);
    }
  }

  /** The fallback: state from the newest status file of each event (statusfiles.ts). */
  #applyStatusFiles(paneId: PaneId): void {
    const fg = this.#panes.foreground(paneId);
    // Ignore status written before the current agent process started.
    const notBefore = fg?.startedAt ? fg.startedAt - 500 : 0;
    let status = null;
    for (const root of this.#statusRoots) if ((status = readStatus(paneId, notBefore, root))) break;
    if (!status) return;
    let agent = this.#byPane(paneId);
    if (!agent) {
      if (fg?.class.kind !== "other" || !status.agent) return;
      agent = this.#create({ kind: status.agent, paneId, source: "detected" });
      this.#started.add(agent.id);
    }
    this.#hooked.add(agent.id);
    this.#update(agent, statusChange(agent.kind, status), { lastPrompt: status.lastPrompt ?? agent.lastPrompt });
  }

  /** A pane's spooled events, stored; unclaimed (no agent) until an agent takes them. */
  #drain(paneId: PaneId): { raw: RawEvent; ev: ActivityEvent }[] {
    if (!this.#statusRoot) return [];
    const { events, bad } = drainSpool(this.#statusRoot, paneId);
    const agent = this.#byPane(paneId);
    for (const b of bad) this.emit("activity", this.activity.note("anomaly", `unreadable hook event file ${b}`, Date.now(), paneId, agent?.id ?? null, agent?.kind ?? null));
    return events.map((raw) => {
      const ev = this.activity.insert(raw, paneId, agent?.id ?? null);
      this.emit("activity", ev);
      return { raw, ev };
    });
  }

  /**
   * Reduces new events into the agent's state; the first time, also the pane's
   * earlier unclaimed ones (hooks often fire before the process is detected).
   * Returns whether the agent's state now comes from events.
   */
  #ingest(paneId: PaneId, fresh: { raw: RawEvent; ev: ActivityEvent }[], agent: Agent | null): boolean {
    if (!agent) return false;
    let red = this.#reducers.get(agent.id);
    let events = fresh.map((f) => f.ev);
    const live = new Set(events.map((e) => e.id));
    if (!red) {
      const fg = this.#panes.foreground(paneId);
      const notBefore = fg?.startedAt ? fg.startedAt - 500 : agent.createdAt - 5000;
      const claimed = this.activity.claim(paneId, agent.id, notBefore);
      if (!claimed.length) return false;
      red = this.#reducerFor(agent);
      events = claimed.filter((e) => e.id > red!.replayedTo);
    }
    for (const ev of events) {
      if (ev.agent && ev.agent !== agent.kind && ev.source === "hook") {
        this.emit("activity", this.activity.note("anomaly", `${ev.agent} hook event in a pane whose agent is ${agent.kind}`, ev.at, paneId, agent.id, agent.kind));
      }
      this.#hooked.add(agent.id);
      this.#applyReduction(agent, red, red.apply(ev), ev, live.has(ev.id));
      if (!this.#agents.has(agent.id)) break; // exited
    }
    return true;
  }

  /** A reducer for an agent, resumed from its last saved turn (a core restart) and the events after it. */
  #reducerFor(agent: Agent): ActivityReducer {
    const saved = this.activity.lastTurn(agent.id);
    const red = new ActivityReducer(agent.id, saved ? saved.turn.index + 1 : 0);
    if (saved) {
      red.turn = saved.turn;
      red.sessionId = saved.turn.sessionId;
      red.lastEventAt = saved.turn.endedAt ?? saved.turn.startedAt;
      red.replayedTo = saved.lastEvent;
    }
    this.#reducers.set(agent.id, red);
    return red;
  }

  #applyReduction(agent: Agent, red: ActivityReducer, r: Reduction, ev: ActivityEvent, live: boolean): void {
    const change: StateChange = { ...r.change };
    if (ev.sessionId) change.native = { ...nativeSession(agent.kind, ev.sessionId), ...change.native };
    // Replayed events (claimed late, or after a restart) don't start subagents or snapshots again.
    if (change.subagent && live) this.#subagent(agent, agent.kind, change.subagent);
    delete change.subagent;
    if (r.exited) {
      // SessionEnd: the agent is gone unless its process is still there (/clear starts a new session).
      const fg = agent.paneId ? this.#panes.foreground(agent.paneId) : null;
      if (fg?.class.kind !== "agent") {
        this.#exit(agent);
        return;
      }
    }
    const fields: Partial<Agent> = {};
    if (r.lastPrompt) fields.lastPrompt = r.lastPrompt;
    if (r.cause && change.state) fields.stateCause = r.cause;
    if (r.turn) {
      this.activity.saveTurn(r.turn, ev.id);
      fields.turn = structuredClone(r.turn);
    }
    if (ev.home && ev.agent) this.emit("home", ev.agent, ev.home);
    else if (ev.kind === "session.start" && ev.transcriptPath && ev.agent) this.emit("transcript", ev.agent, ev.transcriptPath);
    this.#update(agent, change, fields);
    if (live && this.#git) {
      if (r.opened) this.#snapStart(agent, r.opened);
      if (r.closed) void this.#snapEnd(agent, red, r.closed);
    }
  }

  #snapStart(agent: Agent, t: AgentTurn): void {
    const cwd = agent.cwd;
    if (!cwd) return;
    const entry: { git: Promise<GitSnapshot | null>; watch: TurnWatch | null } = { git: snapshot(cwd), watch: null };
    // Not a repository: watch the folder instead, unless the turn is over already.
    void entry.git.then((s) => {
      if (!s && this.#snaps.get(`${agent.id}:${t.index}`) === entry && t.endedAt === null) entry.watch = watchTurn(cwd);
    });
    this.#snaps.set(`${agent.id}:${t.index}`, entry);
  }

  /** The files that changed during a turn (git, or the folder watch), added to it once known. */
  async #snapEnd(agent: Agent, red: ActivityReducer, t: AgentTurn): Promise<void> {
    const key = `${agent.id}:${t.index}`;
    const entry = this.#snaps.get(key);
    this.#snaps.delete(key);
    if (!entry) return;
    const before = await entry.git;
    let changed: Map<string, string>;
    let via: "git" | "fs";
    if (before) {
      const after = await snapshot(before.top);
      if (!after) return;
      changed = await changedBetween(before, after);
      via = "git";
    } else if (entry.watch) {
      changed = entry.watch.stop();
      via = "fs";
    } else return;
    if (!changed.size) return;
    for (const [p, c] of changed) addFile(t, p, c, via);
    this.activity.saveTurn(t);
    const a = this.#agents.get(agent.id);
    if (a && red.turn === t) this.#update(a, {}, { turn: structuredClone(t) });
  }

  #onPaneRemoved(paneId: PaneId): void {
    const a = this.#byPane(paneId);
    if (a) this.#exit(a);
  }

  #exit(agent: Agent): void {
    this.#told.delete(agent.id);
    if (agent.paneId) this.#panes.setAgent(agent.paneId, null);
    this.#started.delete(agent.id);
    this.#hooked.delete(agent.id);
    const children = this.#children(agent.id);
    // Virtual children die with their host process.
    for (const c of children) if (!c.paneId) this.#remove(c.id);
    const remaining = this.#children(agent.id);
    if (remaining.length === 0) {
      this.#remove(agent.id);
    } else {
      // Keep a host with live workers visible so the tree stays intact.
      this.#update(agent, { state: "exited", detail: null }, { paneId: null });
    }
  }

  // ── hooks ──────────────────────────────────────────────────

  /**
   * An event sent over the socket (hook.ingest). `spooled`: cmd's hook already
   * put it in the spool, so the spool is read instead (peer briefings ask before
   * answering). Otherwise (the old `cmd hook`) it goes into the log here.
   */
  ingestHook(paneId: PaneId, kind: AgentKind, event: string, payload: Record<string, unknown>, spooled = false): Agent | null {
    const pane = this.#panes.get(paneId);
    if (!pane) return null;
    if (spooled && this.#statusRoot) {
      this.applyStatus(paneId);
      const a = this.#byPane(paneId);
      if (a || event === "SessionEnd") return a ? this.get(a.id) : null;
    }
    let agent = this.#byPane(paneId);
    if (!agent) {
      if (event === "SessionEnd") return null;
      agent = this.#create({ kind, paneId, source: "detected" });
    }
    this.#started.add(agent.id);
    const ev = this.activity.insert({ at: Date.now(), agent: kind, name: event, payload }, paneId, agent.id);
    this.emit("activity", ev);
    this.#ingest(paneId, [{ raw: { at: ev.at, agent: kind, name: event, payload }, ev }], agent);
    return this.#agents.has(agent.id) ? this.get(agent.id) : null;
  }

  #subagent(parent: Agent, kind: AgentKind, s: NonNullable<StateChange["subagent"]>): void {
    let child = [...this.#agents.values()].find((a) => a.native.claudeAgentId === s.id);
    if (s.op === "start") {
      if (!child) {
        child = this.#create({
          kind,
          paneId: null,
          source: "claude-subagent",
          parentId: parent.id,
          name: s.type ?? "subagent",
          cwd: parent.cwd,
        });
        child.native.claudeAgentId = s.id;
      }
      this.#update(child, { state: "working" });
    } else if (child) {
      this.#update(child, { state: "done", detail: null, lastMessage: s.lastMessage });
    }
  }

  // ── host API ───────────────────────────────────────────────

  spawn(p: SpawnParams): Agent {
    const parent = p.parentId ? this.#agents.get(p.parentId) : undefined;
    if (p.parentId && !parent) throw new Error(`no such parent agent: ${p.parentId}`);
    const cwd = p.cwd ?? parent?.cwd;
    const agent = this.#create({
      kind: p.kind,
      paneId: null,
      spaceId: p.spaceId,
      source: parent ? "host-api" : "user",
      parentId: parent?.id ?? null,
      name: p.name ?? null,
      cwd: cwd ?? process.cwd(),
      prompt: p.prompt,
      operationId: p.operationId,
      state: "starting",
    });
    const { command, sessionId } = launchCommand(p.kind, p.prompt, this.#settings());
    if (sessionId) agent.native.claudeSessionId = sessionId;
    const env: Record<string, string> = { [ENV.agentId]: agent.id };
    if (parent) env[ENV.parentId] = parent.id;
    const pane = this.#panes.create({ cwd, command, env, spaceId: agent.spaceId });
    this.#panes.setAgent(pane.id, agent.id);
    this.#update(agent, {}, { paneId: pane.id, cwd: pane.cwd });
    this.#expectStart(agent.id);
    return this.get(agent.id)!;
  }

  /**
   * If the launch command fails (typo, missing binary) or exits at once, the agent's
   * process never appears; drop the record once the pane is back at a shell.
   */
  #expectStart(id: AgentId): void {
    const t = setTimeout(() => {
      const a = this.#agents.get(id);
      if (!a || this.#started.has(id) || a.state !== "starting" || !a.paneId) return;
      const fg = this.#panes.foreground(a.paneId);
      if (!fg || fg.class.kind === "shell") this.#exit(a);
    }, this.#startTimeoutMs);
    t.unref();
  }

  /** Resume (or fork) a past session in a new pane. */
  resume(p: Methods["agent.resume"]["params"]): Agent {
    const command = this.#sources.resumeCommand(p.agent, p.sessionId, p.env ?? null, !!p.fork, this.#settings());
    const cwd = p.cwd && fs.existsSync(p.cwd) ? p.cwd : os.homedir();
    const agent = this.#create({ kind: p.agent, paneId: null, spaceId: p.spaceId, source: "restored", cwd, state: "starting" });
    if (!p.fork) agent.native = { ...agent.native, ...nativeSession(p.agent, p.sessionId) };
    const pane = this.#panes.create({ cwd, command, env: { [ENV.agentId]: agent.id }, spaceId: agent.spaceId });
    this.#panes.setAgent(pane.id, agent.id);
    this.#update(agent, {}, { paneId: pane.id });
    this.#expectStart(agent.id);
    return this.get(agent.id)!;
  }

  /** Command that resumes this agent's session from any shell; null without one. */
  resumeCommand(id: AgentId): string | null {
    const a = this.#must(id);
    const command = this.#resumeOf(a);
    return command && `cd ${shq(a.cwd)} && ${command}`;
  }

  /**
   * The command that resumes a session in its own folder; null without one.
   * `saved`: only a session whose transcript exists (a session started with
   * --session-id has none until its first prompt, and can't be resumed).
   */
  #resumeOf(a: Agent, saved = false): string | null {
    const sessionId = sessionIdOf(a);
    if (!sessionId || !this.#sources.get(a.kind)) return null;
    if (saved && !(a.native.transcriptPath && fs.existsSync(a.native.transcriptPath))) return null;
    // The transcript's folder says which config dir (profile) the session lives in.
    const env = a.native.transcriptPath ? this.#sources.resumeEnv(a.kind, a.native.transcriptPath, locateContext()) : null;
    return this.#sources.resumeCommand(a.kind, sessionId, env, false, this.#settings());
  }

  /** How a stored agent's session is resumed in a resurrected pane (see restore.ts); null: it can't be. */
  resumeOfStored(a: Agent): string | null {
    return this.#resumeOf(a, true);
  }

  /**
   * Bring back an agent from the store: still running in a reattached pane
   * (`live`), or being resumed in a resurrected one (its pane typed the resume
   * command). Keeps its id, so its children, env and the UI's state still match.
   */
  restore(stored: Agent, live: boolean): Agent {
    const parent = stored.parentId ? this.#agents.get(stored.parentId) : undefined;
    const now = Date.now();
    const agent: Agent = {
      ...stored,
      // A parent that didn't come back makes this the root of its own tree.
      parentId: parent?.id ?? null,
      rootId: parent?.rootId ?? stored.id,
      depth: parent ? parent.depth + 1 : 0,
      spaceId: (stored.paneId && this.#panes.get(stored.paneId)?.spaceId) || parent?.spaceId || stored.spaceId,
      ...(live ? {} : { state: "starting" as const, stateSince: now, detail: null }),
    };
    this.#agents.set(agent.id, agent);
    if (agent.paneId) this.#panes.setAgent(agent.paneId, agent.id);
    if (live) {
      // Its process kept running: return to the shell means it exited.
      this.#started.add(agent.id);
      if (agent.paneId) this.applyStatus(agent.paneId);
    } else this.#expectStart(agent.id);
    log.info(`agent ${agent.id.slice(0, 8)} ${live ? "reattached" : "resumed"}`, { pane: agent.paneId?.slice(0, 8) ?? null });
    this.emit("restored", { ...agent });
    this.#emitUpdate(agent);
    return { ...agent };
  }

  async send(id: AgentId, text: string, submit = true): Promise<void> {
    const a = this.#must(id);
    if (!a.paneId) throw new Error(`agent ${id} has no terminal`);
    this.#panes.write(a.paneId, text);
    // Agent TUIs treat a fast burst as a paste; submit separately.
    if (submit) {
      await new Promise((r) => setTimeout(r, 60));
      this.#panes.write(a.paneId, "\r");
    }
  }

  wait(ids: AgentId[], until: AgentState[], mode: "any" | "all" = "all", timeoutMs = 50_000) {
    const done = (): boolean => {
      const hits = ids.map((id) => {
        const a = this.#agents.get(id);
        return !a || until.includes(a.state); // a removed agent counts as finished
      });
      return mode === "any" ? hits.some(Boolean) : hits.every(Boolean);
    };
    const snapshot = () => ids.map((id) => this.get(id)).filter((a): a is Agent => !!a);
    return new Promise<{ agents: Agent[]; timedOut: boolean }>((resolve) => {
      if (done()) return resolve({ agents: snapshot(), timedOut: false });
      const check = () => {
        if (!done()) return;
        cleanup();
        resolve({ agents: snapshot(), timedOut: false });
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ agents: snapshot(), timedOut: true });
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("updated", check);
        this.off("removed", check);
      };
      this.on("updated", check);
      this.on("removed", check);
    });
  }

  kill(id: AgentId, tree = false): AgentId[] {
    this.#must(id);
    const targets = tree ? [...this.#descendants(id).reverse(), id] : [id];
    for (const t of targets) {
      const a = this.#agents.get(t);
      if (!a) continue;
      if (a.paneId) this.#panes.kill(a.paneId);
      else this.#remove(a.id);
    }
    return targets;
  }

  /** Move an agent, its descendants and their terminals to another Space. */
  moveTree(id: AgentId, spaceId: SpaceId): void {
    for (const t of [id, ...this.#descendants(id)]) {
      const a = this.#agents.get(t);
      if (!a) continue;
      if (a.paneId) this.#panes.setSpace(a.paneId, spaceId);
      if (a.spaceId !== spaceId) this.#update(a, {}, { spaceId });
    }
  }

  /** Drop every agent without a trace (no events, rows kept): their terminals are about to be restored (see PaneManager.replaceBackend). */
  forget(): void {
    this.#agents.clear();
    this.#reducers.clear();
    this.#hooked.clear();
    this.#started.clear();
  }

  markSeen(id: AgentId): void {
    const a = this.#must(id);
    this.#update(a, {}, { seenAt: Date.now() });
  }

  // ── internals ──────────────────────────────────────────────

  #create(o: {
    kind: AgentKind;
    paneId: PaneId | null;
    /** Default: the pane's Space, else the parent's, else Home. */
    spaceId?: SpaceId;
    source: Agent["spawn"]["source"];
    parentId?: AgentId | null;
    name?: string | null;
    cwd?: string;
    prompt?: string;
    operationId?: string;
    state?: AgentState;
  }): Agent {
    const parent = o.parentId ? this.#agents.get(o.parentId) : undefined;
    const id = randomUUID();
    const now = Date.now();
    const pane = o.paneId ? this.#panes.get(o.paneId) : null;
    const agent: Agent = {
      id,
      paneId: o.paneId,
      spaceId: o.spaceId ?? pane?.spaceId ?? parent?.spaceId ?? HOME_SPACE_ID,
      kind: o.kind,
      name: o.name ?? null,
      cwd: o.cwd ?? pane?.cwd ?? process.cwd(),
      parentId: parent?.id ?? null,
      rootId: parent?.rootId ?? id,
      depth: parent ? parent.depth + 1 : 0,
      spawn: { source: o.source, operationId: o.operationId, prompt: o.prompt },
      native: {},
      state: o.state ?? "idle",
      stateSince: now,
      detail: null,
      lastMessage: null,
      lastPrompt: null,
      seenAt: null,
      createdAt: now,
    };
    this.#agents.set(id, agent);
    if (o.paneId) this.#panes.setAgent(o.paneId, id);
    log.info(`agent ${id.slice(0, 8)} ${o.kind} (${o.source})`, { pane: o.paneId?.slice(0, 8) ?? null, parent: o.parentId?.slice(0, 8) ?? null });
    this.#emitUpdate(agent);
    return agent;
  }

  #update(agent: Agent, change: StateChange, fields: Partial<Agent> = {}): void {
    // The status backstop re-applies unchanged status every 2 s: only real changes are saved and broadcast.
    let dirty = false;
    for (const [k, v] of Object.entries(fields) as [keyof Agent, unknown][]) {
      if (agent[k] === v) continue;
      (agent as unknown as Record<string, unknown>)[k] = v;
      dirty = true;
    }
    if (change.state && change.state !== agent.state) {
      log.debug(`agent ${agent.id.slice(0, 8)} ${agent.state} → ${change.state}`);
      agent.state = change.state;
      agent.stateSince = Date.now();
      dirty = true;
    }
    if (change.detail !== undefined && change.detail !== agent.detail) {
      agent.detail = change.detail;
      dirty = true;
    }
    if (change.lastMessage !== undefined && change.lastMessage !== agent.lastMessage) {
      agent.lastMessage = change.lastMessage;
      dirty = true;
    }
    if (change.native && Object.entries(change.native).some(([k, v]) => agent.native[k as keyof Agent["native"]] !== v)) {
      agent.native = { ...agent.native, ...change.native };
      dirty = true;
    }
    if (change.cwd && change.cwd !== agent.cwd) {
      agent.cwd = change.cwd;
      dirty = true;
    }
    if (dirty) this.#emitUpdate(agent);
  }

  #emitUpdate(agent: Agent): void {
    this.#store?.saveAgent(agent);
    this.emit("updated", { ...agent });
  }

  #remove(id: AgentId): void {
    this.#reducers.delete(id);
    for (const [key, snap] of this.#snaps) {
      if (!key.startsWith(`${id}:`)) continue;
      snap.watch?.stop();
      this.#snaps.delete(key);
    }
    if (!this.#agents.delete(id)) return;
    this.#store?.deleteAgent(id);
    this.#hooked.delete(id);
    this.#started.delete(id);
    this.emit("removed", id);
  }

  #byPane(paneId: PaneId): Agent | undefined {
    for (const a of this.#agents.values()) if (a.paneId === paneId) return a;
    return undefined;
  }

  #children(id: AgentId): Agent[] {
    return [...this.#agents.values()].filter((a) => a.parentId === id);
  }

  #descendants(id: AgentId): AgentId[] {
    const out: AgentId[] = [];
    for (const c of this.#children(id)) out.push(c.id, ...this.#descendants(c.id));
    return out;
  }

  #must(id: AgentId): Agent {
    const a = this.#agents.get(id);
    if (!a) throw new Error(`no such agent: ${id}`);
    return a;
  }
}

export function sessionIdOf(a: Agent): string | null {
  return a.native.claudeSessionId ?? a.native.codexThreadId ?? null;
}

function statusChange(kind: AgentKind, s: HookStatus): StateChange {
  const detail = s.state === "needs_input" ? (s.message ?? "Needs input") : s.state === "working" ? s.activity : null;
  const native: StateChange["native"] = s.sessionId ? nativeSession(kind, s.sessionId) : {};
  if (s.transcriptPath) native.transcriptPath = s.transcriptPath;
  return { state: s.state, detail, native, cwd: s.cwd ?? undefined };
}

/** Typed into the user's shell (not exec'd) so aliases and sandbox wrappers still apply. */
export function launchCommand(
  kind: AgentKind,
  prompt?: string,
  settings: Settings = DEFAULT_SETTINGS,
): { command: string; sessionId?: string } {
  const arg = prompt ? ` ${shq(prompt)}` : "";
  if (kind === "claude") {
    const sessionId = randomUUID();
    return { command: `${settings["agents.claude.command"]} --session-id ${sessionId}${arg}`, sessionId };
  }
  if (kind === "codex") return { command: `${settings["agents.codex.command"]}${arg}` };
  return { command: `${kind}${arg}` };
}

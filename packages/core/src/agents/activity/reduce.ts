// Agent state and turns from the event stream: one reducer per agent, fed events
// in order. Pure (no I/O), so recorded sessions replay through it in tests.
// What the agent says decides the state; where it says nothing (an interrupt sends
// no Stop) a named rule does, and the turn records which (`inferred`).

import path from "node:path";
import { TURN_FORMAT, type ActivityEvent, type AgentId, type AgentKind, type AgentTurn } from "@cmd/protocol";
import type { StateChange } from "../state.ts";

/** No events and no terminal output for this long ends a turn whose agent went quiet. */
export const QUIET_MS = 30_000;
/** The same while a tool call is in flight (long commands can be silent). */
export const QUIET_TOOL_MS = 5 * 60_000;
const MAX_COMMANDS = 10;

export interface Reduction {
  change: StateChange;
  lastPrompt?: string;
  /** Why the state is what it is now. */
  cause?: string;
  /** The turn changed. */
  turn?: AgentTurn;
  /** A turn began (take a "before" snapshot) or ended (take the "after" one). */
  opened?: AgentTurn;
  closed?: AgentTurn;
  exited?: boolean;
}

const line1 = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? s).trim();

/** What a turn carries about its agent and who derived it (it outlives the agent). */
export interface TurnContext {
  agentKind: AgentKind;
  agentVersion?: string | null;
  derivedBy?: string | null;
}

export function newTurn(agentId: AgentId, index: number, at: number, ev?: ActivityEvent, ctx: TurnContext = { agentKind: ev?.agent ?? "unknown" }): AgentTurn {
  return {
    format: TURN_FORMAT,
    derivedBy: ctx.derivedBy ?? null,
    agentId,
    agentKind: ctx.agentKind,
    agentVersion: ctx.agentVersion ?? ev?.agentVersion ?? null,
    model: ev?.model ?? null,
    index,
    sessionId: ev?.sessionId ?? null,
    turnId: ev?.turnId ?? null,
    startedAt: at,
    endedAt: null,
    prompt: null,
    auto: false,
    background: [],
    outcome: "working",
    ask: null,
    final: null,
    error: null,
    tools: [],
    commands: [],
    shellWrites: 0,
    files: [],
    subagents: 0,
    events: 0,
    inferred: [],
  };
}

export class ActivityReducer {
  readonly agentId: AgentId;
  sessionId: string | null = null;
  /** The current turn, or the last one once it ended. */
  turn: AgentTurn | null = null;
  lastEventAt = 0;
  /** Events up to this id are already in `turn` (it was saved with them; see ActivityLog.lastTurn). */
  replayedTo = 0;
  #next: number;
  /** Tool calls started and not ended: id (or name) → start time, and → tool name. */
  #open = new Map<string, number>();
  #openNames = new Map<string, string>();

  /** The agent and who derives: kept with every turn. The agent's version can arrive later (setVersion). */
  readonly ctx: TurnContext;
  /** The model the agent last said it uses. */
  model: string | null = null;

  constructor(agentId: AgentId, nextIndex = 0, ctx: TurnContext = { agentKind: "unknown" }) {
    this.agentId = agentId;
    this.#next = nextIndex;
    this.ctx = { ...ctx };
  }

  get open(): boolean {
    return !!this.turn && this.turn.endedAt === null;
  }

  apply(ev: ActivityEvent): Reduction {
    const r: Reduction = { change: {} };
    this.lastEventAt = Math.max(this.lastEventAt, ev.at);
    if (ev.model) this.model = ev.model;
    if (ev.agentVersion && !this.ctx.agentVersion) this.ctx.agentVersion = ev.agentVersion;
    if (ev.sessionId && ev.transcriptPath) r.change.native = { transcriptPath: ev.transcriptPath };
    if (ev.cwd) r.change.cwd = ev.cwd;
    const cause = `hook ${ev.name}`;

    // A new session (resume, /clear) ends whatever was open in the old one.
    if (ev.sessionId && ev.sessionId !== this.sessionId) {
      if (this.sessionId && this.open) this.#close(r, ev.at, "interrupted", "new session before the turn ended");
      this.sessionId = ev.sessionId;
    }
    // Events after a turn the core declared over: it wasn't.
    if (!this.open && this.turn?.outcome === "interrupted" && this.turn.inferred.some((i) => i.startsWith("quiet")) && reopens(ev)) {
      this.turn.endedAt = null;
      this.turn.outcome = "working";
      this.turn.inferred = this.turn.inferred.filter((i) => !i.startsWith("quiet"));
      r.turn = this.turn;
    }
    if (this.open && ev.kind !== "prompt" && ev.kind !== "session.start" && ev.kind !== "session.end") this.turn!.events++;

    switch (ev.kind) {
      case "session.start":
        if (!this.open) this.#state(r, { state: "idle", detail: null }, cause);
        break;
      case "prompt": {
        if (this.open) this.#close(r, ev.at, "interrupted", "a new prompt before the turn ended");
        const t = this.#openTurn(r, ev);
        t.prompt = ev.text ?? null;
        t.auto = !!ev.auto;
        t.events = 1;
        this.#state(r, { state: "working", detail: null }, cause);
        if (ev.text && !ev.auto) r.lastPrompt = line1(ev.text);
        break;
      }
      case "tool.start": {
        if (ev.subagent) break; // a subagent's call: the child's activity, not this agent's
        const t = this.#ensureTurn(r, ev);
        if (t.outcome === "waiting") t.outcome = "working";
        if (ev.tool) {
          this.#open.set(ev.tool.id ?? ev.tool.name, ev.at);
          this.#openNames.set(ev.tool.id ?? ev.tool.name, ev.tool.name);
          const row = t.tools.find((x) => x.name === ev.tool!.name);
          if (row) row.count++;
          else t.tools.push({ name: ev.tool.name, count: 1, failed: 0 });
          if (ev.tool.command) t.commands = [...t.commands, ev.tool.command].slice(-MAX_COMMANDS);
          if (ev.tool.writes) t.shellWrites++;
        }
        r.turn = t;
        this.#state(r, { state: "working", detail: ev.tool?.label ?? null }, cause);
        break;
      }
      case "tool.end": {
        if (ev.subagent) break;
        const t = this.#ensureTurn(r, ev);
        if (t.outcome === "waiting") t.outcome = "working";
        if (ev.tool) {
          const key = ev.tool.id ?? ev.tool.name;
          const k = this.#open.has(key) ? key : ev.tool.name;
          this.#open.delete(k);
          this.#openNames.delete(k);
          let row = t.tools.find((x) => x.name === ev.tool!.name);
          if (!row) t.tools.push((row = { name: ev.tool.name, count: 1, failed: 0 }));
          if (ev.tool.ok === false) row.failed++;
          else for (const p of ev.tool.paths ?? []) addFile(t, ev.cwd && !path.isAbsolute(p) ? path.join(ev.cwd, p) : p, "M", "tool");
        }
        r.turn = t;
        this.#state(r, { state: "working" }, cause);
        break;
      }
      case "ask": {
        const t = this.#ensureTurn(r, ev);
        const message = ev.text ?? "Needs input";
        t.ask = { message, ...(ev.tool ? { tool: ev.tool.name } : {}), ...(ev.tool?.command || ev.tool?.paths?.[0] ? { input: ev.tool.command ?? ev.tool.paths![0] } : {}) };
        t.outcome = "waiting";
        r.turn = t;
        this.#state(r, { state: "needs_input", detail: line1(message) }, cause);
        break;
      }
      case "idle":
        // Idle at its prompt with a turn still open: it ended without a Stop (interrupted).
        if (this.open && this.turn!.outcome === "working") {
          this.#close(r, ev.at, "interrupted", "agent idle at its prompt");
          this.#state(r, { state: "idle", detail: null }, `${cause} (idle_prompt)`);
        }
        break;
      case "stop": {
        const t = this.#ensureTurn(r, ev);
        t.final = ev.text ?? t.final;
        t.background = ev.background ?? [];
        this.#close(r, ev.at, "done");
        this.#state(r, { state: "done", detail: null, ...(ev.text ? { lastMessage: ev.text } : {}) }, cause);
        break;
      }
      case "fail": {
        const t = this.#ensureTurn(r, ev);
        t.error = ev.text ?? "Request failed";
        this.#close(r, ev.at, "failed");
        this.#state(r, { state: "failed", detail: line1(t.error) }, cause);
        break;
      }
      case "compact":
        if (this.open) this.#state(r, { state: "working" }, cause);
        break;
      case "subagent.start":
        if (this.open) {
          this.turn!.subagents++;
          r.turn = this.turn!;
        }
        if (ev.subagent) r.change.subagent = { op: "start", id: ev.subagent, type: ev.text };
        break;
      case "subagent.stop":
        if (ev.subagent) r.change.subagent = { op: "stop", id: ev.subagent, lastMessage: ev.text };
        break;
      case "session.end":
        if (this.open) this.#close(r, ev.at, "interrupted", "session ended before the turn did");
        r.exited = true;
        break;
    }
    return r;
  }

  /**
   * Called periodically: ends an open turn whose agent went quiet (no events, no
   * output) without saying so, which is what an interrupt looks like. `outputAt`:
   * the terminal's last output.
   */
  tick(now: number, outputAt: number): Reduction | null {
    if (!this.open || this.turn!.outcome !== "working") return null;
    const quiet = this.#open.size ? QUIET_TOOL_MS : QUIET_MS;
    const since = Math.max(this.lastEventAt, outputAt);
    if (now - since < quiet) return null;
    const r: Reduction = { change: {} };
    this.#open.clear();
    this.#openNames.clear();
    this.#close(r, since, "interrupted", `quiet for ${Math.round(quiet / 1000)} s with no answer`);
    this.#state(r, { state: "idle", detail: null }, `inferred: quiet for ${Math.round(quiet / 1000)} s`);
    return r;
  }

  #openTurn(r: Reduction, ev: ActivityEvent): AgentTurn {
    this.#open.clear();
    this.#openNames.clear();
    this.turn = newTurn(this.agentId, this.#next++, ev.at, ev, this.ctx);
    if (!this.turn.sessionId) this.turn.sessionId = this.sessionId;
    if (!this.turn.model) this.turn.model = this.model;
    r.opened = this.turn;
    r.turn = this.turn;
    return this.turn;
  }

  /** The open turn; one without a prompt if events arrive outside any (the core started mid-turn). */
  #ensureTurn(r: Reduction, ev: ActivityEvent): AgentTurn {
    if (this.open) return this.turn!;
    const t = this.#openTurn(r, ev);
    t.events = 1;
    t.inferred.push("began before cmd saw its prompt");
    return t;
  }

  #close(r: Reduction, at: number, outcome: AgentTurn["outcome"], inferred?: string): void {
    const t = this.turn;
    if (!t || t.endedAt !== null) return;
    t.endedAt = at;
    t.outcome = outcome;
    if (inferred) t.inferred.push(inferred);
    // Calls that never reported back by the turn's end didn't complete (denied, or failed without saying: Codex's apply_patch).
    if (this.#open.size && outcome !== "interrupted") {
      for (const name of this.#openNames.values()) {
        const row = t.tools.find((x) => x.name === name);
        if (row) row.failed++;
      }
      t.inferred.push(`${this.#open.size} tool call${this.#open.size > 1 ? "s" : ""} never finished`);
    }
    this.#open.clear();
    this.#openNames.clear();
    r.closed = t;
    r.turn = t;
  }

  #state(r: Reduction, change: StateChange, cause: string): void {
    r.change = { ...r.change, ...change };
    r.cause = cause;
  }
}

/** Events that show a turn was still going (not a new prompt or session). */
const reopens = (ev: ActivityEvent) => ev.kind === "tool.start" || ev.kind === "tool.end" || ev.kind === "ask" || ev.kind === "stop" || ev.kind === "fail" || ev.kind === "compact";

export function addFile(t: AgentTurn, path: string, change: string, via: "git" | "fs" | "tool"): void {
  const f = t.files.find((x) => x.path === path);
  if (!f) t.files.push({ path, change, via: [via] });
  else {
    if (!f.via.includes(via)) f.via.push(via);
    if (via !== "tool") f.change = change;
  }
}

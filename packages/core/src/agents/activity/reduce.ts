// Agent state and turns from the event stream: one reducer per agent, fed events
// in order. Pure (no I/O), so recorded sessions replay through it in tests.
// What the agent says decides the state; where it says nothing (an interrupt sends
// no Stop) a named rule does, and the turn records which (`inferred`).

import path from "node:path";
import { TURN_FORMAT, type ActivityEvent, type AgentId, type AgentKind, type AgentTurn } from "@cmd/protocol";
import { QUESTIONS, type StateChange } from "../state.ts";

/** No events and no terminal output for this long ends a turn whose agent went quiet. */
export const QUIET_MS = 30_000;
/** Output this long after a question means it was answered (a denial redraws once, then goes quiet). */
export const ANSWERED_MS = 3000;
/** The same while a tool call is in flight: agents animate a timer while their tools run, so their screens stay busy (seen live in Claude and Codex). */
export const QUIET_TOOL_MS = 60_000;
const MAX_COMMANDS = 10;
/**
 * Tools that run a subagent in the foreground without marking its calls (Gemini's
 * invoke_agent): calls while one is open are the subagent's. Claude marks its
 * subagents' calls (agent_id) and may run other tools beside its Agent tool.
 */
const LAUNCHERS = new Set(["invoke_agent"]);
const MAX_FOLLOWUPS = 10;
const MAX_TEXT = 2000;

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
    followUps: [],
    notes: [],
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
  /** Events up to this id are already in `turn` (it was saved with them; see ActivityView.lastTurn). */
  replayedTo = 0;
  #next: number;
  /** Tool calls started and not ended: id (or name) → start time, and → tool name. */
  #open = new Map<string, number>();
  /** When the open turn's last question was asked. */
  #askAt = 0;
  /** Subagents announced by subagent.start and not stopped yet. */
  #subagents = new Set<string>();
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
    // A subagent's cwd is its own (an isolated one works in another worktree).
    if (ev.cwd && !ev.subagent) r.change.cwd = ev.cwd;
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
        // While it waited for an answer: the question was dismissed (a permission dialog takes all input
        // until answered; Gemini sends nothing when it's declined), so that turn is over.
        if (this.open && this.turn!.outcome === "waiting") this.#close(r, ev.at, "interrupted", "declined: a new prompt while it waited for an answer");
        // Typed while the agent works: it steers the same turn (Claude takes it in mid-turn and goes on).
        if (this.open) {
          const t = this.turn!;
          if (ev.text) t.followUps = [...t.followUps, ev.text.length > MAX_TEXT ? ev.text.slice(0, MAX_TEXT - 1) + "…" : ev.text].slice(-MAX_FOLLOWUPS);
          t.events++;
          r.turn = t;
          this.#state(r, { state: "working", detail: null }, cause);
          if (ev.text && !ev.auto) r.lastPrompt = line1(ev.text);
          break;
        }
        const t = this.#openTurn(r, ev);
        t.prompt = ev.text ?? null;
        t.auto = !!ev.auto;
        t.events = 1;
        this.#state(r, { state: "working", detail: null }, cause);
        if (ev.text && !ev.auto) r.lastPrompt = line1(ev.text);
        break;
      }
      case "tool.start": {
        if (ev.subagent || this.#nested(ev)) break; // a subagent's call: the child's activity, not this agent's
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
        // A question's call puts it up: waiting, whether or not a permission request follows.
        if (ev.tool && QUESTIONS.has(ev.tool.name)) this.#ask(r, t, ev, cause);
        else this.#state(r, { state: "working", detail: ev.tool?.label ?? null }, cause);
        break;
      }
      case "tool.end": {
        if (ev.subagent || this.#nested(ev)) break;
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
        // A reminder about the question already up (Claude's "needs your permission" a few seconds later) doesn't replace it.
        if (t.outcome === "waiting" && t.ask?.tool && !ev.tool) break;
        // The permission request for a question already up (Claude asks one for AskUserQuestion) is the same question.
        if (t.outcome === "waiting" && t.ask?.tool && QUESTIONS.has(t.ask.tool) && ev.tool?.name === t.ask.tool) break;
        this.#ask(r, t, ev, cause);
        break;
      }
      case "idle":
        // Idle at its prompt with a turn still open: it ended without a Stop (interrupted), or its question was dismissed.
        if (this.open && (this.turn!.outcome === "working" || this.turn!.outcome === "waiting")) {
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
        if (ev.subagent) this.#subagents.add(ev.subagent);
        if (this.open) {
          this.turn!.subagents++;
          r.turn = this.turn!;
        }
        if (ev.subagent) r.change.subagent = { op: "start", id: ev.subagent, type: ev.text };
        break;
      case "subagent.stop":
        // One that never started is a helper of the agent's own (Claude's next-prompt suggestions, recaps): a note on the turn, not a child.
        if (ev.subagent && !this.#subagents.has(ev.subagent)) {
          if (ev.text && this.turn) {
            this.turn.notes = [...this.turn.notes, ev.text.length > MAX_TEXT ? ev.text.slice(0, MAX_TEXT - 1) + "…" : ev.text].slice(-MAX_FOLLOWUPS);
            r.turn = this.turn;
          }
          break;
        }
        if (ev.subagent) {
          this.#subagents.delete(ev.subagent);
          r.change.subagent = { op: "stop", id: ev.subagent, lastMessage: ev.text };
        }
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
    if (!this.open) return null;
    // A question dismissed without an answer event (Codex and Gemini send none for Esc or a denial):
    // the terminal changed after the question, then nothing for a while. A dialog that waits stays still.
    if (this.turn!.outcome === "waiting") {
      // A question tool: only the agent says how it ended (the tool's end, a new prompt, idle at its prompt).
      if (this.turn!.ask?.tool && QUESTIONS.has(this.turn!.ask.tool)) return null;
      // Still busy well after the question (the approved command's output, the agent's working timer):
      // it was answered. Agents send nothing for an approval until the call ends.
      if (outputAt > this.#askAt + ANSWERED_MS && now - outputAt < 2500) {
        const r: Reduction = { change: {} };
        this.turn!.outcome = "working";
        r.turn = this.turn!;
        this.#state(r, { state: "working", detail: this.turn!.ask?.input ?? null }, "inferred: question answered");
        return r;
      }
      if (outputAt <= this.#askAt + 500 || now - Math.max(this.lastEventAt, outputAt) < QUIET_MS) return null;
      const r: Reduction = { change: {} };
      this.#close(r, outputAt, "interrupted", "declined: the screen changed after the question, then nothing");
      this.#state(r, { state: "idle", detail: null }, "inferred: question dismissed");
      return r;
    }
    if (this.turn!.outcome !== "working") return null;
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

  #ask(r: Reduction, t: AgentTurn, ev: ActivityEvent, cause: string): void {
    const message = ev.text ?? "Needs input";
    t.ask = { message, ...(ev.tool ? { tool: ev.tool.name } : {}), ...(ev.tool?.command || ev.tool?.paths?.[0] ? { input: ev.tool.command ?? ev.tool.paths![0] } : {}) };
    t.outcome = "waiting";
    this.#askAt = ev.at;
    r.turn = t;
    this.#state(r, { state: "needs_input", detail: line1(message) }, cause);
  }

  /** Inside a foreground subagent's launcher call, and not the launcher itself. */
  #nested(ev: ActivityEvent): boolean {
    if (!ev.tool || LAUNCHERS.has(ev.tool.name)) return false;
    for (const name of this.#openNames.values()) if (LAUNCHERS.has(name)) return true;
    return false;
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

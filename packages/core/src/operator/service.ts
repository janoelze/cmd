// The Operator's conversations (docs/51-operator.md): one per workspace, owned by the core, so
// closing the widget or the app doesn't stop a turn and reopening shows it where it is. A turn
// is one ai.agent run over the whole history; each tool call becomes an item the chat shows
// (and the board marks, when it acts), waits for the person when it must (tools/approvals.ts),
// and goes through TOOL_ACCESS, like every caller of the tools (docs/54). Messages sent while a turn runs wait for the next one. Kept in cmd's
// database, a row per workspace.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ModelMessage } from "ai";
import type { Agent, AgentId, AgentState, Method, NewDataEvent, OperatorPast, PaneId, OperatorConversation, OperatorEvent, OperatorItem, OperatorUsage, Params, Result, WindowId, Workspace, WorkspaceId } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { AgentCall, AgentResult, AgentRun } from "../ai/backends.ts";
import type { ToolOutput } from "../magic/tools.ts";
import { AiNotConfigured } from "../ai/service.ts";
import { OPERATOR_TITLE } from "@cmd/protocol";
import { TOOL_ACCESS } from "../tools/access.ts";
import type { Approvals } from "../tools/approvals.ts";
import { Refs, agentLine, clip, look } from "../tools/board.ts";
import { RULES_VERSION, systemPrompt } from "./prompt.ts";
import { workspaceBrief } from "./brief.ts";
import { ConversationStore, type Saved } from "./store.ts";
import { TOOLS, type Approval, type ToolContext, type Tool } from "../tools/index.ts";

const log = logger("operator");

/** Tool steps in one turn before the Operator must answer. */
export const MAX_STEPS = 40;
/** Denials in a row that end a turn: the person wants something else. */
const DENIALS = 3;
/** What a tool returns to the model, at most; the card shows less. */
const OUTPUT_MAX = 30_000;
const CARD_MAX = 4000;
/** Items kept per conversation (the model's history is trimmed separately). */
const ITEMS_MAX = 600;
/** Old tool results are replaced by a line once the history is longer than this (characters). */
const HISTORY_MAX = 400_000;

export interface OperatorDeps {
  workspace(id: WorkspaceId): Workspace | null;
  /** A method as the core runs it (Core.call); the service gates it. */
  call(method: Method, params: unknown): Promise<unknown>;
  /** One run of the model over the conversation (AiService.agent). */
  agent(r: AgentRun): Promise<AgentResult>;
  /** The Operator's window in a workspace, if one is open. */
  selfIn(workspaceId: WorkspaceId): WindowId | null;
  broadcast(e: OperatorEvent): void;
  /** Every change to an agent (AgentTracker's updated): the Operator hears about the ones it started. */
  onAgent?(fn: (a: Agent) => void): void;
  /** A command ended in a terminal (OSC 133 D), with its exit status. */
  onCommandEnd?(fn: (paneId: PaneId, exitCode: number | null) => void): void;
  /** A Workspace Action's run printed its address (ActionsService's url). */
  onServing?(fn: (paneId: PaneId, url: string) => void): void;
  /** A turn waits for the person, ended or failed while nobody looked (a notification). */
  /** Tell the person (a notification from the Operator's window: the app skips it while they look at that window). */
  notify?(workspaceId: WorkspaceId, n: { title: string; body: string; urgent: boolean }): void;
  /** Into the event log (docs/28): each turn (operator.turn) and each tool call in it (operator.tool). */
  record?(e: NewDataEvent): void;
  /** The conversation's name changed (null: none yet): the Operator's windows are titled after it. */
  named?(workspaceId: WorkspaceId, name: string | null): void;
  /** A name for a conversation from its requests and answers (docs/32's namer, the fast tier); null when there's none to give. */
  name?(turns: { prompt: string; final: string | null; at: number }[], project: string | null): Promise<string | null>;
  /** Where conversations are kept (cmd's database); null: in memory only (tests). */
  db: DatabaseSync | null;
  /** Calls waiting for the person, and the approvals remembered per workspace (shared with every caller of the tools). */
  approvals: Approvals;
}

interface Conversation {
  workspaceId: WorkspaceId;
  name: string | null;
  items: OperatorItem[];
  messages: ModelMessage[];
  refs: Refs;
  system: string | null;
  /** The rules the system prompt was made with (RULES_VERSION). */
  rules: string | null;
  usage: OperatorUsage;
  model: string | null;
  latency: OperatorConversation["latency"];
  busy: boolean;
  abort: AbortController | null;
  queue: { text: string; selected: WindowId | null }[];
  /** Agents it started, and the state each was last reported in. */
  agents: Map<AgentId, AgentState>;
  /** Terminals running a command it started: what it is (for the news) and the address it serves. */
  commands: Map<PaneId, { label: string; url: string | null }>;
  /** News not yet told: with the next tool result while a turn runs, else in a turn of its own. */
  news: string[];
  /** Its calls waiting for the person (ids in Approvals). */
  approvals: Set<string>;
  denials: number;
}

const zero = (): OperatorUsage => ({ input: 0, output: 0, cacheRead: 0 });

export class OperatorService {
  #d: OperatorDeps;
  #store: ConversationStore;
  #all = new Map<WorkspaceId, Conversation>();

  constructor(d: OperatorDeps) {
    this.#d = d;
    this.#store = new ConversationStore(d.db);
    d.onAgent?.((a) => this.#agentChanged(a));
    d.onCommandEnd?.((paneId, exitCode) => this.#commandEnded(paneId, exitCode));
    d.onServing?.((paneId, url) => this.#serving(paneId, url));
  }

  // ── what it started reports back ───────────────────────
  // Agents (done, failed, needs input), commands it ran or typed (when they end, with their
  // status) and servers (their address, once printed) are news: told with the next tool
  // result while a turn runs, else in a turn of its own. Only what it started, so the person's
  // own agents and commands never start a (paid) turn.

  /** Be told when this agent is done, fails or needs input. */
  watchAgent(workspaceId: WorkspaceId, agentId: AgentId, state: AgentState = "starting"): void {
    const c = this.#conv(workspaceId);
    c.agents.set(agentId, state);
    this.#save(c);
  }

  /** Be told when the command just started in this terminal ends, and a server's address once it prints one. */
  watchCommand(workspaceId: WorkspaceId, paneId: PaneId, label: string): void {
    const c = this.#conv(workspaceId);
    c.commands.set(paneId, { label, url: null });
    this.#save(c);
  }

  /** States worth telling about an agent it started. */
  static readonly NEWS: readonly AgentState[] = ["done", "needs_input", "failed", "exited"];

  #agentChanged(a: Agent): void {
    for (const c of this.#watchers()) {
      const was = c.agents.get(a.id);
      if (was === undefined || was === a.state) continue;
      if (a.state === "exited") c.agents.delete(a.id);
      else c.agents.set(a.id, a.state);
      if (OperatorService.NEWS.includes(a.state)) this.#tell(c, newsLine(a), `${a.paneId ? c.refs.of(a.paneId) : "its terminal"}: ${agentLine(a)}`);
    }
  }

  #commandEnded(paneId: PaneId, exitCode: number | null): void {
    for (const c of this.#watchers()) {
      const cmd = c.commands.get(paneId);
      if (!cmd) continue;
      c.commands.delete(paneId);
      const how = exitCode === null ? "ended" : exitCode === 0 ? "ended (status 0)" : `failed (status ${exitCode})`;
      this.#tell(c, `${cmd.label} ${exitCode === 0 || exitCode === null ? "ended" : "failed"}.`, `${c.refs.of(paneId)}: ${cmd.label} ${how}. Read it for its output.`);
    }
  }

  #serving(paneId: PaneId, url: string): void {
    for (const c of this.#watchers()) {
      const cmd = c.commands.get(paneId);
      if (!cmd || cmd.url === url) continue;
      cmd.url = url;
      this.#tell(c, `${cmd.label} is up at ${url}.`, `${c.refs.of(paneId)}: ${cmd.label} serves ${url} (it keeps running).`);
    }
  }

  /** News: a row in the chat (`line`, for people), the model's text, and a turn if none runs. */
  #tell(c: Conversation, line: string, text: string): void {
    this.#add(c, { kind: "event", id: randomUUID(), at: Date.now(), text: line });
    c.news.push(text);
    this.#save(c);
    if (!c.busy) void this.#turn(c);
  }

  /** Conversations waiting on something they started, the ones on disk included (an agent may finish before its workspace's Operator is opened again). */
  #watchers(): Conversation[] {
    if (!this.#loaded) {
      this.#loaded = true;
      for (const id of this.#store.workspaces()) this.#conv(id);
    }
    return [...this.#all.values()].filter((c) => c.agents.size || c.commands.size);
  }

  #loaded = false;

  get(workspaceId: WorkspaceId): OperatorConversation {
    const c = this.#conv(workspaceId);
    return { workspaceId, name: c.name, items: c.items, busy: c.busy, usage: c.usage, model: c.model, latency: c.latency };
  }

  send(workspaceId: WorkspaceId, text: string, selected: WindowId | null = null): void {
    const t = text.trim();
    if (!t) throw new Error("say what you'd like done");
    if (!this.#d.workspace(workspaceId)) throw new Error(`no workspace ${workspaceId}`);
    const c = this.#conv(workspaceId);
    this.#add(c, { kind: "user", id: randomUUID(), at: Date.now(), text: t });
    c.queue.push({ text: t, selected });
    if (!c.busy) void this.#turn(c);
  }

  stop(workspaceId: WorkspaceId): void {
    const c = this.#all.get(workspaceId);
    if (!c) return;
    c.queue = [];
    c.abort?.abort(new Error("stopped"));
    for (const id of c.approvals) this.#d.approvals.cancel(id, "stopped");
  }

  /** A new conversation; the current one is put away. What it started still reports back (to the new one). */
  reset(workspaceId: WorkspaceId): void {
    this.stop(workspaceId);
    const c = this.#conv(workspaceId);
    this.#putAway(c);
    this.#replace(c, null);
  }

  /** The workspace's past conversations, newest first. */
  history(workspaceId: WorkspaceId): OperatorPast[] {
    return this.#store.history(workspaceId);
  }

  /** Back to a past conversation; the current one is put away in its place. */
  open(workspaceId: WorkspaceId, id: string): void {
    const saved = this.#store.take(workspaceId, id);
    if (!saved) throw new Error("that conversation is gone");
    this.stop(workspaceId);
    const c = this.#conv(workspaceId);
    this.#putAway(c);
    this.#replace(c, saved);
  }

  /** The conversation becomes `saved` (null: empty), keeping what it waits on; the app is told. */
  #replace(c: Conversation, saved: Saved | null): void {
    Object.assign(c, { name: saved?.name ?? null, items: saved?.items ?? [], messages: saved?.messages ?? [], refs: new Refs(saved?.refs), system: saved?.system ?? null, rules: saved?.rules ?? null, news: [], usage: saved?.usage ?? zero(), model: saved?.model ?? null, latency: null, denials: 0 });
    this.#save(c);
    this.#d.named?.(c.workspaceId, c.name);
    this.#d.broadcast({ type: "operator.changed", workspaceId: c.workspaceId, reset: true, name: c.name, items: c.items, busy: false, usage: c.usage, model: c.model, latency: null });
  }

  /** Into the past conversations, if there is anything in it. */
  #putAway(c: Conversation): void {
    const requests = c.items.filter((i) => i.kind === "user");
    if (!c.items.length) return;
    const title = (c.name ?? requests[0]?.text ?? c.items.find((i) => i.kind === "event")?.text ?? "Conversation").replace(/\s+/g, " ").slice(0, 120);
    this.#store.putAway(c.workspaceId, { title, at: c.items.at(-1)!.at, requests: requests.length }, this.#saved(c));
  }

  dispose(): void {
    for (const id of this.#all.keys()) this.stop(id);
  }

  // ── a turn ─────────────────────────────────────────────

  async #turn(c: Conversation): Promise<void> {
    const asked = c.queue.splice(0);
    const news = c.news.splice(0);
    if (!asked.length && !news.length) return;
    const ws = this.#d.workspace(c.workspaceId);
    if (!ws) return;
    const abort = new AbortController();
    const t0 = Date.now();
    let firstStep: number | null = null;
    c.busy = true;
    c.abort = abort;
    c.denials = 0;
    this.#d.broadcast({ type: "operator.changed", workspaceId: c.workspaceId, busy: true });
    const done: OperatorItem[] = [];
    const request = asked.length ? asked.map((a) => a.text).join("\n\n") : `(news) ${news.join("; ")}`;
    const turn = { id: `operator:${randomUUID()}`, at: t0, type: "operator.turn" as const, source: "cmd", workspaceId: c.workspaceId, text: request.split("\n")[0]!.slice(0, 200) };
    const firstItem = c.items.length;
    let error: string | null = null;
    let stopped = false;
    let tokens = { in: 0, out: 0 };
    this.#d.record?.({ ...turn, data: { steps: 0, denied: 0, stopped: false, error: null, model: null, tokens, firstStepMs: null, ms: null, answer: null }, content: request });
    try {
      const bench = this.#bench(c, abort.signal);
      // Made once per conversation (the provider caches it), again when the rules changed since.
      if (!c.system || c.rules !== RULES_VERSION) (c.system = systemPrompt({ root: ws.root, brief: await workspaceBrief(bench) }).text), (c.rules = RULES_VERSION);
      // The board as it is now goes with the request, so the first step needn't be a look.
      const board = await this.#safe(() => this.#look(bench));
      // "this": only a window open in this workspace.
      const open = new Set((await this.#safe(() => bench.call("window.list", {})))?.filter((w) => w.workspaceId === ws.id).map((w) => w.id));
      const selected = asked.map((a) => a.selected).filter((id): id is WindowId => !!id && open.has(id)).pop();
      const told = news.length ? `${asked.length ? "\n\n" : "(No message from the person: news came in. Tell them in a line or two what it means and what you'll do; act on it if it's what they asked for.)\n\n"}<news>\n${news.map((n) => `- ${n}`).join("\n")}\n</news>` : "";
      const text = asked.map((a) => a.text).join("\n\n") + told;
      const content = `${text}${selected ? `\n\n(The person has ${c.refs.of(selected)} selected: "this" means it.)` : ""}${board ? `\n\n<board>\n${board}\n</board>` : ""}`;
      c.messages.push({ role: "user", content });
      this.#trim(c);
      let current: Extract<OperatorItem, { kind: "text" }> | null = null;
      let flush: NodeJS.Timeout | null = null;
      const emitText = () => {
        flush = null;
        if (current) this.#d.broadcast({ type: "operator.changed", workspaceId: c.workspaceId, items: [current] });
      };
      let acting: Promise<void> = Promise.resolve();
      const r = await this.#d.agent({
        system: c.system,
        messages: [...c.messages],
        tools: TOOLS.map((t) => t.spec),
        maxSteps: MAX_STEPS,
        signal: abort.signal,
        onStep: () => {
          if (flush) clearTimeout(flush), emitText();
          current = null;
        },
        onText: (delta) => {
          if (!current) {
            current = { kind: "text", id: randomUUID(), at: Date.now(), text: "" };
            this.#add(c, current);
          }
          current.text += delta;
          flush ??= setTimeout(emitText, 50);
        },
        exec: async (call) => {
          firstStep ??= Date.now() - t0;
          const tool = TOOLS.find((t) => t.spec.name === call.name);
          if (!tool) return { output: `no tool ${call.name}`, isError: true };
          // Acts go one at a time, in the order the model asked; reads run beside them.
          if (!tool.acts) return this.#exec(c, tool, call, bench, done, abort, turn.id);
          const run = acting.then(() => this.#exec(c, tool, call, bench, done, abort, turn.id));
          acting = run.then(() => undefined, () => undefined);
          return run;
        },
      });
      if (flush) clearTimeout(flush), emitText();
      c.messages.push(...r.messages);
      c.model = r.model;
      tokens = { in: r.usage.input, out: r.usage.output };
      c.usage = { input: c.usage.input + r.usage.input, output: c.usage.output + r.usage.output, cacheRead: c.usage.cacheRead + r.usage.cacheRead };
    } catch (e) {
      stopped = abort.signal.aborted;
      if (!stopped) error = (e as Error).message;
      // The model's own messages for this turn are lost with the stream: what was done goes back as a note.
      const steps = done.filter((i) => i.kind === "tool").map((i) => `- ${(i as { why: string }).why}: ${(i as { state: string }).state}`);
      c.messages.push({ role: "assistant", content: `(${stopped ? "The person stopped me" : `I failed: ${(e as Error).message}`}.${steps.length ? ` Done before that:\n${steps.join("\n")}` : ""})` });
      for (const i of c.items) if (i.kind === "tool" && (i.state === "running" || i.state === "waiting")) this.#update(c, { ...i, state: "failed", output: stopped ? "Stopped." : i.output });
      this.#add(c, { kind: "error", id: randomUUID(), at: Date.now(), text: stopped ? "Stopped." : friendly(e as Error) });
      if (!stopped) log.warn(`turn failed: ${(e as Error).message}`);
    } finally {
      c.busy = false;
      c.abort = null;
      c.latency = { firstStepMs: firstStep, totalMs: Date.now() - t0 };
      const answer = c.items.slice(firstItem).flatMap((i) => (i.kind === "text" ? [i.text] : [])).join("\n\n").trim() || null;
      // Done or failed, for when the person looked away (stopped: they know).
      if (error) this.#d.notify?.(c.workspaceId, { title: `${c.name ?? "The Operator"} stopped`, body: friendly(new Error(error)), urgent: false });
      else if (!stopped && answer) this.#d.notify?.(c.workspaceId, { title: c.name ?? "The Operator", body: plainLine(answer), urgent: false });
      const denied = done.filter((i) => i.kind === "tool" && i.state === "denied").length;
      this.#d.record?.({ ...turn, until: Date.now(), data: { steps: done.length, denied, stopped, error, model: c.model, tokens, firstStepMs: firstStep, ms: Date.now() - t0, answer: answer?.slice(0, 2000) ?? null }, content: `${request}${answer ? `\n\n=== answer ===\n\n${answer}` : ""}` });
      this.#save(c);
      this.#d.broadcast({ type: "operator.changed", workspaceId: c.workspaceId, busy: false, usage: c.usage, model: c.model, latency: c.latency });
    }
    if (!c.name && !stopped && !error) void this.#nameIt(c);
    if (c.queue.length || c.news.length) void this.#turn(c);
  }

  /** One tool call: its card, the person's approval when it needs one, the call, the result. */
  async #exec(c: Conversation, tool: Tool, call: AgentCall, bench: ToolContext, done: OperatorItem[], abort: AbortController, turnId: string): Promise<ToolOutput> {
    const { why, ...input } = call.input;
    let target: WindowId | null = null;
    try {
      target = tool.target?.(call.input, bench) ?? null;
    } catch {
      // a bad ref: the run below says so
    }
    const item: Extract<OperatorItem, { kind: "tool" }> = { kind: "tool", id: call.id, at: Date.now(), tool: tool.spec.name, why: typeof why === "string" && why.trim() ? why.trim() : tool.spec.name, acts: tool.acts, target, state: "running", input };
    this.#add(c, item);
    const t0 = Date.now();
    let approval: { ask: Approval; allowed: boolean | null; reason: string | null; remembered?: string } | null = null;
    const end = (state: "done" | "failed" | "denied", output: string, isError: boolean): ToolOutput => {
      const next = { ...item, ...(approval ? { ask: approval.ask.title, exact: approval.ask.exact, ...(approval.remembered ? { remembered: approval.remembered } : {}) } : {}), state, output: clip(output, CARD_MAX), ms: Date.now() - t0 };
      this.#update(c, next);
      done.push(next);
      // News that came in while this ran goes back with it.
      const news = c.news.splice(0);
      const sent = clip(output, OUTPUT_MAX) + (news.length ? `\n\n<news>\n${news.map((n) => `- ${n}`).join("\n")}\n</news>` : "");
      this.#d.record?.({ id: `operator:${call.id}`, at: t0, until: Date.now(), type: "tool.call", source: "cmd", parentId: turnId, workspaceId: c.workspaceId, windowId: target, text: item.why, data: { caller: bench.caller.name, tool: item.tool, acts: item.acts, state, input, ask: approval?.ask.title ?? null, exact: approval?.ask.exact ?? null, allowed: approval?.allowed ?? null, reason: approval?.reason ?? null, remembered: approval?.remembered ?? null, ms: next.ms }, content: sent });
      return { output: sent, isError };
    };
    try {
      const ask = tool.confirm ? await tool.confirm(call.input, bench) : null;
      // Allowed here before, and remembered: it runs, and says so.
      const grant = ask?.rule ? this.#d.approvals.remembered(c.workspaceId, ask.rule.key) : null;
      if (ask && grant) {
        approval = { ask, allowed: true, reason: null, remembered: grant.label };
        this.#update(c, { ...item, ask: ask.title, exact: ask.exact, remembered: grant.label });
        return end("done", await tool.run(call.input, { ...bench, call: this.#gate(true, abort.signal) }), false);
      }
      if (ask) {
        this.#update(c, { ...item, state: "waiting", ask: ask.title, exact: ask.exact, ...(ask.rule ? { offer: ask.rule.label } : {}) });
        this.#d.notify?.(c.workspaceId, { title: `${c.name ?? "The Operator"} asks`, body: ask.title, urgent: true });
        c.approvals.add(item.id);
        const a = await this.#d.approvals.wait(item.id, c.workspaceId).finally(() => c.approvals.delete(item.id));
        approval = { ask, allowed: a.allow, reason: a.reason ?? null };
        if (a.remember && ask.rule) this.#d.approvals.remember(c.workspaceId, ask.rule.key, ask.rule.label);
        if (!a.allow) {
          if (++c.denials >= DENIALS) queueMicrotask(() => abort.abort(new Error("denied")));
          return end("denied", `The person said no${a.reason ? `: ${a.reason}` : ""}. Don't do this another way; ask what they want instead.`, true);
        }
        c.denials = 0;
        this.#update(c, { ...item, ask: ask.title, exact: ask.exact, state: "running" });
        const out = await tool.run(call.input, { ...bench, call: this.#gate(true, abort.signal) });
        return end("done", out, false);
      }
      return end("done", await tool.run(call.input, bench), false);
    } catch (e) {
      return end("failed", (e as Error).message, true);
    }
  }

  /** The tools' view of cmd: the Operator as the caller, the workspace, its methods gated by TOOL_ACCESS (confirm ones only once allowed). */
  #bench(c: Conversation, signal: AbortSignal): ToolContext {
    return {
      caller: { kind: "agent", workspaceId: c.workspaceId, name: c.name ?? OPERATOR_TITLE, windowId: this.#d.selfIn(c.workspaceId) },
      workspace: () => {
        const ws = this.#d.workspace(c.workspaceId);
        if (!ws) throw new Error("the workspace is closed");
        return ws;
      },
      call: this.#gate(false, signal),
      refs: c.refs,
      started: { agent: (id) => this.watchAgent(c.workspaceId, id), command: (paneId, label) => this.watchCommand(c.workspaceId, paneId, label) },
      signal,
    };
  }

  #gate(allowed: boolean, signal: AbortSignal): ToolContext["call"] {
    return <M extends Method>(method: M, params: Params<M>) => {
      if (signal.aborted) return Promise.reject(new Error("stopped"));
      const access = TOOL_ACCESS[method];
      if (access === "never") return Promise.reject(new Error(`the Operator may not call ${method}`));
      // A dry page action only finds and outlines the element: it is what the approval shows.
      const dry = method === "browser.act" && (params as Params<"browser.act">).dry === true;
      if (access === "confirm" && !allowed && !dry) return Promise.reject(new Error(`${method} needs the person's approval first`));
      // Whatever a tool does, an Operator window stays: the person's way to watch and stop it.
      if (method === "window.close") return this.#closing((params as Params<"window.close">).id).then(() => this.#d.call(method, params) as Promise<Result<M>>);
      return this.#d.call(method, params) as Promise<Result<M>>;
    };
  }

  /** Name the conversation once it has a request and an answer: what it is about, in the person's words. */
  async #nameIt(c: Conversation): Promise<void> {
    if (!this.#d.name) return;
    const turns: { prompt: string; final: string | null; at: number }[] = [];
    for (const i of c.items) {
      if (i.kind === "user") turns.push({ prompt: i.text, final: null, at: i.at });
      else if (i.kind === "text" && turns.length) turns.at(-1)!.final = i.text;
    }
    if (!turns.length) return;
    const ws = this.#d.workspace(c.workspaceId);
    const name = await this.#d.name(turns, ws && !ws.home ? (ws.root.split("/").pop() ?? null) : null).catch(() => null);
    if (!name || c.name) return;
    c.name = name;
    this.#save(c);
    this.#d.named?.(c.workspaceId, name);
    this.#d.broadcast({ type: "operator.changed", workspaceId: c.workspaceId, name });
  }

  async #closing(id: WindowId): Promise<void> {
    const windows = (await this.#d.call("window.list", {})) as { id: WindowId; kind: string }[];
    if (windows.find((w) => w.id === id)?.kind === "operator") throw new Error("an Operator window can't be closed by the Operator");
  }

  async #look(b: ToolContext): Promise<string> {
    const [windows, panes, agents] = await Promise.all([b.call("window.list", {}), b.call("pane.list", {}), b.call("agent.list", {})]);
    return look({ workspace: b.workspace(), windows, panes, agents, self: b.caller.windowId ?? null }, b.refs);
  }

  async #safe<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  /** Old tool results go first when the history grows: a line says what was there (it can be read again; what the person said can't). */
  #trim(c: Conversation): void {
    let size = JSON.stringify(c.messages).length;
    for (const m of c.messages) {
      if (size <= HISTORY_MAX) break;
      if (m.role !== "tool" || !Array.isArray(m.content)) continue;
      for (const part of m.content as { type: string; output?: { type: string; value: unknown } }[]) {
        if (part.type !== "tool-result" || !part.output || part.output.type !== "text") continue;
        const before = String(part.output.value).length;
        if (before < 400) continue;
        part.output = { type: "text", value: "(An earlier result, left out to save room: call the tool again if you need it.)" };
        size -= before;
      }
    }
  }

  // ── items and storage ──────────────────────────────────

  #add(c: Conversation, item: OperatorItem): void {
    c.items.push(item);
    if (c.items.length > ITEMS_MAX) c.items.splice(0, c.items.length - ITEMS_MAX);
    this.#d.broadcast({ type: "operator.changed", workspaceId: c.workspaceId, items: [item] });
  }

  #update(c: Conversation, item: OperatorItem): void {
    const i = c.items.findIndex((x) => x.id === item.id);
    if (i >= 0) c.items[i] = item;
    this.#d.broadcast({ type: "operator.changed", workspaceId: c.workspaceId, items: [item] });
  }

  #conv(workspaceId: WorkspaceId): Conversation {
    let c = this.#all.get(workspaceId);
    if (c) return c;
    const saved = this.#store.load(workspaceId);
    c = {
      workspaceId,
      name: saved?.name ?? null,
      items: saved?.items ?? [],
      messages: saved?.messages ?? [],
      refs: new Refs(saved?.refs),
      system: saved?.system ?? null,
      rules: saved?.rules ?? null,
      usage: saved?.usage ?? zero(),
      model: saved?.model ?? null,
      latency: null,
      busy: false,
      abort: null,
      queue: [],
      agents: new Map(saved?.agents ?? []),
      commands: new Map(saved?.commands ?? []),
      news: [],
      approvals: new Set(),
      denials: 0,
    };
    // A turn that was running when the core stopped didn't finish.
    for (const [i, it] of c.items.entries()) if (it.kind === "tool" && (it.state === "running" || it.state === "waiting")) c.items[i] = { ...it, state: "failed", output: "cmd restarted." };
    this.#all.set(workspaceId, c);
    return c;
  }

  #saved(c: Conversation): Saved {
    return { name: c.name, items: c.items, messages: c.messages, refs: c.refs.toJSON(), system: c.system, rules: c.rules, agents: [...c.agents], commands: [...c.commands], usage: c.usage, model: c.model };
  }

  #save(c: Conversation): void {
    this.#store.save(c.workspaceId, c.items.length || c.messages.length || c.agents.size || c.commands.size ? this.#saved(c) : null);
  }
}

/** News for the person: "Claude “Bug hunt” is done." */
function newsLine(a: Agent): string {
  const who = `${a.kind === "claude" ? "Claude" : a.kind === "codex" ? "Codex" : a.kind}${a.name ? ` “${a.name}”` : ""}`;
  const what = a.state === "done" ? "is done" : a.state === "needs_input" ? "needs input" : a.state === "failed" ? "failed" : "ended";
  return `${who} ${what}.`;
}

/** The start of an answer as one plain line, for a notification. */
function plainLine(md: string): string {
  const t = md.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]|\[([^\]]*)\]\([^)]*\)/g, (_m, link) => link ?? "").replace(/\s+/g, " ").trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}

function friendly(e: Error): string {
  if (e instanceof AiNotConfigured) return "Set up AI first: Settings → AI.";
  return `Something went wrong: ${e.message}`;
}

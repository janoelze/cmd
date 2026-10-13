// Running the tools for an agent in a pane (docs/54, callers in panes): what
// tools.list and tools.call do for `cmd mcp` and `cmd tool`. The caller is the pane: proven by its
// CMD_PANE_TOKEN (else read-only), else found from the caller's process ancestry. Each call is
// checked against TOOL_ACCESS whatever the agent's own approval said; one that must ask the person
// waits for an answer in cmd, on the window it acts on (tool.acting, approvals.answer); acts run
// one at a time per caller and light up the window acted on. What a caller starts reports back
// (reports.ts); every call goes into the event log as a tool.call.

import { randomUUID } from "node:crypto";
import { kindLabel, type Method, type PaneId, type Params, type Result, type ToolActivity, type ToolCaller, type ToolInfo } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import { TOOL_ACCESS } from "./access.ts";
import type { Answer, Approvals } from "./approvals.ts";
import { clip, Refs } from "./board.ts";
import { TOOLS } from "./index.ts";
import type { Approval, Caller, Input, Tool, ToolContext } from "./kit.ts";
import { reportsText, type Reports } from "./reports.ts";

/** What a tool result may be, at most (one agent caps results at 25,000 tokens). */
const OUTPUT_MAX = 20_000;
/** How long a call waits for the person before it gives up. */
const APPROVAL_MS = 15 * 60_000;

/** The tools for coding agents: all but those only for models without tools of their own (edit). */
export const AGENT_TOOLS: Tool[] = TOOLS.filter((t) => t.for !== "models");

/** What cmd's MCP server says about itself (`instructions`): front-loaded, under 500 characters. */
export const INSTRUCTIONS =
  "cmd's tools act on the cmd app you run in, where the person watches your terminal beside other windows: show them a file in cmd's editor, a folder or a web page beside you (open), start other coding agents and wait for them (agent, wait), read other terminals and windows (look, read), run the project's own commands (run), arrange the board. Start with look: windows have refs (w1, w2…). Read and edit files with your own tools.";

/** A tool as callers see it: the hints come from the access table, over the methods it calls. */
export function toolInfo(t: Tool): ToolInfo {
  const access = t.calls.map((m) => TOOL_ACCESS[m]);
  return { name: t.spec.name, description: t.spec.description, inputSchema: t.spec.schema, acts: t.acts, readOnly: access.every((a) => a === "read"), destructive: access.includes("confirm") };
}

type RunnerCore = Pick<CoreContext, "panes" | "agents" | "workspaces" | "settings" | "call" | "data" | "notifications">;

export class ToolRunner {
  #core: RunnerCore;
  #approvals: Approvals;
  #reports: Reports;
  #refs = new Map<PaneId, Refs>();
  /** Per caller, the act running now: the next waits for it. */
  #acting = new Map<PaneId, Promise<unknown>>();
  /** Per caller, its calls waiting for the person. */
  #asking = new Map<PaneId, Set<string>>();
  /** Per caller, the windows it opened itself. */
  #opened = new Map<PaneId, Set<string>>();
  /** Puts a call on the board (ToolsService.show). */
  #show: (a: ToolActivity) => void;

  constructor(core: RunnerCore, approvals: Approvals, reports: Reports, show: (a: ToolActivity) => void) {
    this.#core = core;
    this.#show = show;
    this.#approvals = approvals;
    this.#reports = reports;
    core.panes.on("removed", (id) => {
      this.#refs.delete(id);
      // Nobody is left to tell the answer to.
      for (const call of this.#asking.get(id) ?? []) this.#approvals.cancel(call, "the agent's terminal closed");
      this.#asking.delete(id);
      this.#opened.delete(id);
      approvals.endSession(id);
    });
    // "This session" is the agent's: it ends when the agent does (a new one in the same terminal starts over).
    core.agents.on("removed", (id) => approvals.endSession(id));
    core.agents.on("updated", (a) => a.state === "exited" && approvals.endSession(a.id));
  }

  /** A caller's refs for windows (w1, w2…), kept while its pane lives. */
  refs(paneId: PaneId): Refs {
    let r = this.#refs.get(paneId);
    if (!r) this.#refs.set(paneId, (r = new Refs()));
    return r;
  }

  /** The pane calling, and whether it proved it (the token); null outside a cmd pane. */
  resolve(p: ToolCaller): { paneId: PaneId; trusted: boolean } | null {
    if (p.paneId && this.#core.panes.get(p.paneId)) return { paneId: p.paneId, trusted: this.#core.panes.trusts(p.paneId, p.token ?? undefined) };
    // The env didn't reach the server: the nearest ancestor that is a pane's shell.
    const shells = new Map(this.#core.panes.list().map((x) => [x.pid, x.id]));
    for (const pid of p.pids ?? []) {
      const id = shells.get(pid);
      if (id) return { paneId: id, trusted: !!p.token && this.#core.panes.trusts(id, p.token) };
    }
    return null;
  }

  list(p: ToolCaller): { paneId: PaneId | null; tools: ToolInfo[]; instructions: string } {
    const who = this.#core.settings.settings["agents.integration"] ? this.resolve(p) : null;
    if (!who) return { paneId: null, tools: [], instructions: "" };
    return { paneId: who.paneId, tools: AGENT_TOOLS.filter((t) => who.trusted || !t.acts).map(toolInfo), instructions: INSTRUCTIONS };
  }

  async call(p: ToolCaller & { name: string; input: Input }): Promise<{ output: string; isError: boolean }> {
    if (!this.#core.settings.settings["agents.integration"]) return { output: "cmd's tools are off: Agent integration is off in cmd's Settings → Agents.", isError: true };
    const who = this.resolve(p);
    if (!who) return { output: "Not in a cmd pane: cmd's tools act on the workspace of the terminal they run in.", isError: true };
    const tool = AGENT_TOOLS.find((t) => t.spec.name === p.name);
    if (!tool) return { output: `No tool ${p.name}. The tools: ${AGENT_TOOLS.map((t) => t.spec.name).join(", ")}.`, isError: true };
    if (tool.acts && !who.trusted) return { output: `${p.name} acts, and this caller couldn't show it runs in its pane (CMD_PANE_TOKEN didn't reach it): only the tools that read work.`, isError: true };
    const ctx = this.#context(who.paneId, who.trusted);
    if (!tool.acts) return this.#exec(tool, p.input ?? {}, ctx, who.trusted);
    // Acts go one at a time per caller, in the order asked; reads run beside them.
    const run = (this.#acting.get(who.paneId) ?? Promise.resolve()).then(() => this.#exec(tool, p.input ?? {}, ctx, who.trusted));
    const settled = run.then(() => undefined, () => undefined);
    this.#acting.set(who.paneId, settled);
    void settled.then(() => this.#acting.get(who.paneId) === settled && this.#acting.delete(who.paneId));
    return run;
  }

  /** The caller as the tools see it: its pane's agent, workspace and window. */
  caller(paneId: PaneId): Caller {
    const pane = this.#core.panes.get(paneId);
    if (!pane) throw new Error("the pane is gone");
    const agent = pane.agentId ? this.#core.agents.get(pane.agentId) : null;
    const name = agent ? `${kindLabel(agent.kind)}${agent.name ? ` “${agent.name}”` : ""}` : "A terminal";
    return { kind: "agent", workspaceId: pane.workspaceId, name, windowId: paneId, paneId, agentId: agent?.id ?? null };
  }

  #context(paneId: PaneId, trusted: boolean): ToolContext {
    const caller = this.caller(paneId);
    return {
      caller,
      workspace: () => {
        const ws = this.#core.workspaces.get(this.#core.panes.get(paneId)?.workspaceId ?? caller.workspaceId);
        if (!ws) throw new Error("the workspace is closed");
        return ws;
      },
      call: this.#gate(false, trusted),
      refs: this.refs(paneId),
      opened: this.#openedBy(paneId),
      started: { agent: (id) => this.#reports.watchAgent(paneId, id), command: (pane, label) => this.#reports.watchCommand(paneId, pane, label) },
      reports: (ms, signal) => this.#reports.next(paneId, ms, signal),
      signal: new AbortController().signal,
    };
  }

  #openedBy(paneId: PaneId): Set<string> {
    let s = this.#opened.get(paneId);
    if (!s) this.#opened.set(paneId, (s = new Set()));
    return s;
  }

  /** The core's methods as tools may call them: TOOL_ACCESS first, `confirm` ones only once the person allowed the call. */
  #gate(allowed: boolean, trusted: boolean): ToolContext["call"] {
    return <M extends Method>(method: M, params: Params<M>) => {
      const access = TOOL_ACCESS[method];
      if (access === "never") return Promise.reject(new Error(`tools may not call ${method}`));
      if (access !== "read" && !trusted) return Promise.reject(new Error(`${method} needs the pane's token`));
      // A dry page action only finds and outlines the element: it is what the approval shows.
      const dry = method === "browser.act" && (params as Params<"browser.act">).dry === true;
      if (access === "confirm" && !allowed && !dry) return Promise.reject(new Error(`${method} needs the person's approval first`));
      return this.#core.call(method, params) as Promise<Result<M>>;
    };
  }

  /** One call: its mark on the board, the person's approval when it needs one, the run, the record. */
  async #exec(tool: Tool, input: Input, ctx: ToolContext, trusted: boolean): Promise<{ output: string; isError: boolean }> {
    const id = randomUUID();
    const t0 = Date.now();
    const why = typeof input.why === "string" && input.why.trim() ? input.why.trim() : tool.spec.name;
    let target: string | null = null;
    try {
      target = tool.target?.(input, ctx) ?? null;
    } catch {
      // a bad ref: the run below says so
    }
    const caller = ctx.caller;
    const kind = caller.agentId ? this.#core.agents.get(caller.agentId)?.kind : undefined;
    const shown: ToolActivity = { id, workspaceId: caller.workspaceId, caller: caller.name, ...(kind ? { callerKind: kind } : {}), callerWindowId: caller.windowId ?? null, tool: tool.spec.name, why, acts: tool.acts, target, state: "running" };
    // Reads show only while they wait for the person.
    let asked = false;
    const show = (a: ToolActivity) => {
      asked ||= a.state === "waiting";
      if (a.acts || asked) this.#show(a);
    };
    show(shown);
    let ask: Approval | null = null;
    let answer: Answer | null = null;
    let kept: string | null = null;
    const end = (state: "done" | "failed" | "denied", output: string, isError: boolean) => {
      show({ ...shown, state });
      const told = ctx.caller.paneId ? reportsText(this.#reports.take(ctx.caller.paneId)) : "";
      const sent = clip(output, OUTPUT_MAX) + (told ? `\n\n${told}` : "");
      this.#core.data.record({ id: `tool:${id}`, at: t0, until: Date.now(), type: "tool.call", source: "cmd", workspaceId: caller.workspaceId, agentId: caller.agentId ?? null, paneId: caller.paneId ?? null, windowId: target, text: why, data: { caller: caller.name, tool: tool.spec.name, acts: tool.acts, state, input: withoutWhy(input), permission: ask?.permission ?? null, site: ask?.site ?? null, ask: ask?.title ?? null, exact: answer ? (ask!.exact ?? null) : null, allowed: answer ? answer.allow : null, scope: answer?.scope ?? null, reason: answer?.reason ?? null, remembered: kept, ms: Date.now() - t0 }, content: sent });
      return { output: sent, isError };
    };
    try {
      ask = tool.confirm ? await tool.confirm(input, ctx) : null;
      if (ask) {
        const caller_ = caller.paneId!;
        // Whose session a yes "for this session" is: the agent's, else the terminal's (cmd tool in a shell).
        const session = caller.agentId ?? caller_;
        const d = this.#approvals.decide(session, caller.workspaceId, ask);
        if ("refuse" in d) return end("failed", d.refuse, true);
        if ("run" in d) kept = d.kept ?? null;
        else {
          show({ ...shown, state: "waiting", approval: { title: ask.title, ...(ask.exact ? { exact: ask.exact } : {}), permission: ask.permission, ...(ask.site ? { site: ask.site } : {}), ...(ask.risky ? { risky: true } : {}), scopes: d.ask } });
          this.#core.notifications.send(caller_, `${caller.name} asks`, ask.title);
          const timer = setTimeout(() => this.#approvals.cancel(id, "no answer in time"), APPROVAL_MS);
          const asking = this.#asking.get(caller_) ?? new Set<string>();
          this.#asking.set(caller_, asking.add(id));
          answer = await this.#approvals.wait(id, caller.workspaceId).finally(() => (clearTimeout(timer), asking.delete(id)));
          if (!answer.allow) return end("denied", `The person said no${answer.reason ? `: ${answer.reason}` : ""}. Don't do this another way; ask them what they want instead.`, true);
          this.#approvals.grant(session, caller.workspaceId, ask, answer.scope);
          show({ ...shown, state: "running" });
        }
      }
      const out = await tool.run(input, ask ? { ...ctx, call: this.#gate(true, trusted) } : ctx);
      return end("done", out, false);
    } catch (e) {
      return end("failed", (e as Error).message, true);
    }
  }
}

const withoutWhy = (i: Input): Input => {
  const { why: _why, ...rest } = i;
  return rest;
};

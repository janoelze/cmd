// The widget API's acts (API 1.1, docs/56 phase 4): start, message and stop agents, type into
// or open a terminal, run a Workspace Action, close a window. A widget process is untrusted, so
// each act, in this order:
//
//   1. needs its grant (`act: ["agents"]` or `act: ["agents.start"]`, access.ts's mayAct);
//      which verbs act, what they ask under and which carry typed text is protocol
//      widget-verbs.ts's API row: the plans below are typed by it;
//   2. comes right after the person pressed something in the widget, and takes that press (one
//      act per press: a widget can't act on its own, nor many times on one click);
//   3. names only things in the widget's own workspace, never its own window, by ids the core
//      checks (nothing the process sends picks another workspace, pane or window);
//   4. is refused outright when tools/deny.ts names the typed text, or the action is risky;
//   5. asks the person through tools/approvals.ts (decideWidget): the sheet names the widget, its
//      package and version, and a yes can be kept for the package in this workspace, except for
//      typed text and a press from a paired device, which ask every time;
//   6. runs one at a time per widget, marked on the window it acts on with the widget's name
//      (tool.acting, as an agent's tool call is), and goes into the log as a tool.call.

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { API, actTyped, kindLabel, permissionOf, type Agent, type ApiActVerb, type ApiAgentStart, type ApiTerminalOpen, type AppWindow, type Permission, type ToolActivity, type WidgetPermissions, type WireValue, type Workspace } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { CoreContext } from "../../kernel/context.ts";
import { isDeniedPath, remotePrivatePaths } from "../../lib/paths-deny.ts";
import { RESTORE_COMMAND_ENV } from "../../terminals/restore.ts";
import type { Approvals } from "../../tools/approvals.ts";
import { denied as deniedLine } from "../../tools/deny.ts";
import type { Approval } from "../../tools/kit.ts";
import type { PackageWidget, WidgetPackage } from "../package.ts";
import { ApiRefusal, RateLimit, failed, invalid, mayAct, missing } from "./access.ts";

const log = logger("widgets");

/** How long after a press an act may come. */
export const ACT_AFTER_PRESS_MS = 5000;
/** How long an act waits for the person before it is a no. */
const ASK_MS = 15 * 60_000;
const TEXT_MAX = 20_000;
const LINE_MAX = 2000;

export type ActCore = Pick<CoreContext, "agents" | "panes" | "windows" | "workspaces" | "actions" | "data" | "call" | "opened">;

/** What the acts ask and show through: the tools' approvals and board marks (tools/feature.ts). */
export interface ActDeps {
  approvals: Approvals;
  show(a: ToolActivity): void;
}

/** The press an act needs: when it was, whether it came from a paired device, and taking it. */
export interface Press {
  at(): number;
  remote(): boolean;
  take(): void;
}

export interface ActScope {
  windowId: string;
  workspaceId(): string;
  pkg: WidgetPackage;
  widget: PackageWidget;
  permissions: WidgetPermissions;
  press: Press;
  /** The tools' approvals and marks; null: this core can't ask (an act is then refused). */
  deps: () => ActDeps | null;
}

/** One act, worked out before anything is asked: what to ask (under the verb's `ask` unless it says), where it acts, and doing it. */
interface Plan {
  approval: Omit<Approval, "permission"> & { permission?: Permission };
  /** The window it acts on (for the mark), when known before it runs. */
  target: string | null;
  run(): Promise<{ value: WireValue; target?: string | null }>;
}

/** One widget process's acts: the queue, the windows it opened, what waits for the person. */
export function widgetActs(core: ActCore, scope: ActScope): { call(verb: ApiActVerb, params: WireValue[], press?: Press): Promise<WireValue>; dispose(): void } {
  const rate = new RateLimit(20);
  const opened = new Set<string>();
  const waiting = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const session = `widget:${scope.windowId}`;

  const own = (): Workspace => {
    const ws = core.workspaces.get(scope.workspaceId());
    if (!ws) throw failed("This widget's workspace is gone.");
    return ws;
  };
  const ownPane = (id: unknown) => {
    const p = typeof id === "string" ? core.panes.get(id) : undefined;
    if (!p || p.workspaceId !== own().id) throw invalid(`No terminal ${String(id).slice(0, 60)} in this widget's workspace.`);
    return p;
  };
  const ownAgent = (id: unknown): Agent => {
    const a = typeof id === "string" ? core.agents.get(id) : undefined;
    if (!a || a.workspaceId !== own().id) throw invalid(`No agent ${String(id).slice(0, 60)} in this widget's workspace.`);
    return a;
  };
  const ownWindow = (id: unknown): AppWindow => {
    const w = typeof id === "string" ? core.windows.list().find((x) => x.id === id) : undefined;
    if (!w || w.workspaceId !== own().id) throw invalid(`No window ${String(id).slice(0, 60)} in this widget's workspace.`);
    if (w.id === scope.windowId) throw invalid("A widget can't act on its own window.");
    return w;
  };
  /** A folder to work in: the workspace's, or one inside it (relative to it), never a private one. */
  const folder = (asked: unknown): string => {
    const root = own().root || os.homedir();
    if (asked === undefined || asked === null || asked === "") return root;
    if (typeof asked !== "string") throw invalid("cwd is a folder's path");
    const abs = path.resolve(root, asked);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw invalid(`${asked.slice(0, 120)} is outside the workspace's folder`);
    if (isDeniedPath(abs, remotePrivatePaths())) throw invalid(`${asked.slice(0, 120)} stays private`);
    return abs;
  };
  const text = (v: unknown, what: string, max = TEXT_MAX): string => {
    if (typeof v !== "string" || !v.trim()) throw invalid(`${what}: give it some text`);
    if (v.length > max) throw invalid(`${what}: at most ${max} characters`);
    return v;
  };
  /** One line a person reads before it runs: no Return, Escape or other control characters that would act by themselves. */
  const line = (v: unknown, what: string): string => {
    const t = text(v, what, LINE_MAX);
    if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(t)) throw invalid(`${what}: one line of text, without Return or other control characters`);
    return t;
  };
  const refuseTyped = (t: string) => {
    const why = deniedLine(t);
    if (why) throw new ApiRefusal({ code: "denied", message: `cmd won't type that: it ${why}.` });
  };
  const agentName = (a: Agent) => `${kindLabel(a.kind)}${a.name ? ` “${a.name}”` : ""}`;
  const terminalName = (id: string) => {
    const p = core.panes.get(id);
    const a = p?.agentId ? core.agents.get(p.agentId) : undefined;
    if (a) return agentName(a);
    const rel = p ? path.relative(own().root || os.homedir(), p.cwd) : "";
    return p ? `the terminal in ${rel && !rel.startsWith("..") ? rel : path.basename(p.cwd) || p.cwd}` : "a terminal";
  };
  const windowName = (w: AppWindow) => (w.kind === "terminal" ? terminalName(w.id) : `the window “${w.title}”`);

  const plans: { [V in ApiActVerb]: (p: WireValue[]) => Plan } = {
    "agents.start": ([req]) => {
      const r = (req && typeof req === "object" ? req : {}) as unknown as ApiAgentStart;
      const kind = r.kind === undefined ? "claude" : r.kind;
      if (kind !== "claude" && kind !== "codex") throw invalid("agents.start: kind is \"claude\" or \"codex\"");
      const prompt = text(r.prompt, "agents.start's prompt");
      const cwd = folder(r.cwd);
      const where = path.relative(own().root || os.homedir(), cwd);
      return {
        // The prompt is the whole act (agents often run with their permissions skipped): typed text, asked every
        // time and never kept, for a person's package; a built-in one follows the levels (the row's typed: "person").
        approval: { title: `Start ${kindLabel(kind)} on a task${where ? ` in ${where}` : ""}`, exact: prompt },
        target: null,
        async run() {
          const a = await core.call("agent.spawn", { kind, prompt, workspaceId: own().id, cwd, parentId: null });
          if (a.paneId) opened.add(a.paneId);
          return { value: { id: a.id, terminalId: a.paneId ?? null, windowId: a.paneId ?? null }, target: a.paneId ?? null };
        },
      };
    },
    "agents.send": ([id, msg]) => {
      const a = ownAgent(id);
      const t = text(msg, "agents.send's message");
      return {
        approval: { title: `Send a message to ${agentName(a)}`, exact: t },
        target: a.paneId ?? null,
        run: async () => (await core.call("agent.send", { agentId: a.id, text: t, submit: true }), { value: null }),
      };
    },
    "agents.stop": ([id]) => {
      const a = ownAgent(id);
      return {
        approval: { title: `Stop ${agentName(a)}`, exact: a.cwd },
        target: a.paneId ?? null,
        run: async () => (await core.call("agent.kill", { agentId: a.id }), { value: null }),
      };
    },
    "terminals.type": ([id, msg, opts]) => {
      const p = ownPane(id);
      const t = line(msg, "terminals.type");
      const submit = !!(opts && typeof opts === "object" && (opts as { submit?: unknown }).submit === true);
      if (!p.agentId) refuseTyped(t);
      return {
        approval: { title: `Type in ${terminalName(p.id)}`, exact: submit ? `${t}  ⏎` : t },
        target: p.id,
        run: async () => (await core.call("pane.write", { paneId: p.id, data: t + (submit ? "\r" : "") }), { value: null }),
      };
    },
    "terminals.open": ([req]) => {
      const r = (req && typeof req === "object" ? req : {}) as unknown as ApiTerminalOpen;
      const cwd = folder(r.cwd);
      const command = r.command === undefined || r.command === null || r.command === "" ? null : line(r.command, "terminals.open's command");
      if (command) refuseTyped(command);
      const where = path.relative(own().root || os.homedir(), cwd);
      return {
        approval: { title: command ? `Open a terminal${where ? ` in ${where}` : ""} with a command typed, not run` : `Open a terminal${where ? ` in ${where}` : ""}`, ...(command ? { exact: command } : {}) },
        target: null,
        async run() {
          // Typed at its first prompt by the shell integration (print -z), as a restored terminal's command is: never run.
          const pane = core.panes.create({ workspaceId: own().id, cwd, ...(command ? { env: { [RESTORE_COMMAND_ENV]: command } } : {}) });
          opened.add(pane.id);
          const w = core.windows.list().find((x) => x.id === pane.id);
          if (w) core.opened(w);
          return { value: { id: pane.id }, target: pane.id };
        },
      };
    },
    "actions.run": ([name]) => {
      if (typeof name !== "string" || !name.trim()) throw invalid("actions.run: name the action, as actions.list gives it");
      const ws = own();
      if (!ws.root) throw invalid("This widget's workspace has no folder, so no actions.");
      const list = core.actions.list(ws.root);
      const a = list.actions.find((x) => x.id === name) ?? list.actions.find((x) => x.name === name && !x.package) ?? list.actions.find((x) => x.name === name);
      if (!a) throw invalid(`No action “${name.slice(0, 60)}” in this workspace.`);
      if (a.risky) throw new ApiRefusal({ code: "denied", message: `“${a.name}” is risky (it deploys, publishes or drops something): run it from Workspace Actions.` });
      return {
        approval: { title: `Run “${a.name}”`, exact: a.command },
        target: null,
        async run() {
          const r = await core.call("actions.run", { root: list.root, actionId: a.id, workspaceId: ws.id, restart: false, confirmed: false });
          if (r.started) opened.add(r.paneId);
          return { value: { terminalId: r.paneId, started: r.started }, target: r.paneId };
        },
      };
    },
    "windows.close": ([id]) => {
      const w = ownWindow(id);
      // Closing what it opened is tidying up ("show"); anything else may end someone's work (the row's "stop").
      return {
        approval: { ...(opened.has(w.id) ? { permission: "show" as const } : {}), title: `Close ${windowName(w)}` },
        target: w.id,
        run: async () => (await core.call("window.close", { id: w.id }), { value: null }),
      };
    },
  };

  async function exec(verb: ApiActVerb, plan: Plan, remote: boolean): Promise<WireValue> {
    const deps = scope.deps();
    if (!deps) throw failed("This cmd can't ask the person here, so widgets can't act.");
    const id = randomUUID();
    const t0 = Date.now();
    const ws = own();
    const who = { name: scope.pkg.name, version: scope.pkg.version, title: scope.widget.title, icon: scope.widget.icon };
    const shown: ToolActivity = { id, workspaceId: ws.id, caller: scope.widget.title, callerKind: "widget", callerWindowId: scope.windowId, tool: verb, why: plan.approval.title, acts: true, target: plan.target, state: "running" };
    const a: Approval = { permission: API[verb].ask, ...plan.approval };
    let target = plan.target;
    let answer: { allow: boolean; reason?: string; scope?: string } | null = null;
    let kept: string | null = null;
    const end = (state: "done" | "failed" | "denied", error?: string) => {
      deps.show({ ...shown, target, state });
      core.data.record({ id: `tool:${id}`, at: t0, until: Date.now(), type: "tool.call", source: "cmd", workspaceId: ws.id, windowId: target, text: a.title, data: { caller: scope.widget.title, widget: `${scope.pkg.name} ${scope.pkg.version}`, tool: verb, acts: true, state, permission: a.permission, site: null, ask: a.title, exact: answer ? (a.exact ?? null) : null, allowed: answer ? answer.allow : null, scope: answer?.scope ?? null, reason: answer?.reason ?? null, remembered: kept, remote, ms: Date.now() - t0, error: error ?? null } });
    };
    const d = deps.approvals.decideWidget(session, ws.id, a, { pkg: scope.pkg.name, builtin: !!scope.pkg.builtin, typed: actTyped(verb, !!scope.pkg.builtin), remote });
    if ("refuse" in d) {
      end("denied");
      throw new ApiRefusal({ code: "denied", message: d.refuse });
    }
    if ("run" in d) kept = d.kept ?? null;
    else {
      deps.show({ ...shown, state: "waiting", approval: { title: a.title, ...(a.exact ? { exact: a.exact } : {}), permission: a.permission, scopes: d.ask, widget: who } });
      const timer = setTimeout(() => deps.approvals.cancel(id, "no answer in time"), ASK_MS);
      waiting.add(id);
      answer = await deps.approvals.wait(id, ws.id).finally(() => (clearTimeout(timer), waiting.delete(id)));
      if (!answer.allow) {
        end("denied");
        throw new ApiRefusal({ code: "denied", message: `The person said no${answer.reason ? `: ${answer.reason}` : ""}.` });
      }
      // Kept only as long as was offered: an answer can't keep typed text, or a device's press, for always.
      const held = d.ask.includes(answer.scope as never) ? (answer.scope as "once" | "session" | "always") : "once";
      deps.approvals.grantWidget(session, ws.id, a, scope.pkg.name, held);
    }
    deps.show({ ...shown, state: "running" });
    try {
      const r = await plan.run();
      // A window it made (a terminal, an agent's): marked from now, and for a moment after.
      if (r.target !== undefined && r.target !== target) deps.show({ ...shown, target: (target = r.target), state: "running" });
      end("done");
      return r.value;
    } catch (e) {
      end("failed", (e as Error).message);
      if (e instanceof ApiRefusal) throw e;
      throw failed(`${verb}: ${(e as Error).message.slice(0, 300)}`);
    }
  }

  return {
    async call(verb, params, press = scope.press) {
      if (disposed) throw failed("This widget is stopping.");
      const ns = verb.split(".")[0]!;
      if (!mayAct(scope.permissions, verb)) throw missing("act", ns, `${permissionOf(API[verb].ask)?.title ?? "Acting"} (${verb})`);
      // One act per press, right after it: a widget can't act by itself, nor many times on one click.
      const at = press.at();
      if (Date.now() - at > ACT_AFTER_PRESS_MS) throw invalid(`${verb} works right after the person presses something in the widget.`);
      const remote = press.remote();
      press.take();
      rate.take(verb);
      const plan = plans[verb](Array.isArray(params) ? params : []);
      // Acts go one at a time, in the order pressed; the next waits for the person's answer to this one.
      const run = queue.then(() => exec(verb, plan, remote));
      queue = run.catch(() => undefined);
      return run;
    },
    dispose() {
      disposed = true;
      const deps = scope.deps();
      for (const id of waiting) deps?.approvals.cancel(id, "the widget stopped");
      waiting.clear();
      deps?.approvals.endSession(session);
      log.debug(`widget ${scope.pkg.name}: acts ended`, { window: scope.windowId });
    },
  };
}

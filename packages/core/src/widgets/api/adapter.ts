// The widget API (docs/56, "The host API"): the one core file that knows both sides. Each verb
// of protocol widget-verbs.ts in terms of the core's services, what its API row needs checked
// first; the acts are act.ts's. When the internals move, this file moves with them and no
// widget notices.
// A widget sees its own window's workspace unless granted `workspace: ["all"]`; a terminal's
// screen comes back clipped and marked untrusted; events go through data/policy.ts's widget row.
// Live topics (subscribe) are topics.ts's, over the same reads.

import path from "node:path";
import { API, API_VERBS, isActVerb, parsePackageKind, topicVerb, type ApiEvent, type ApiEventQuery, type ApiMethods, type ApiNotification, type ApiActVerb, type ApiScopeQuery, type ApiTopic, type ApiVerb, type AppWindow, type DataQuery, type WidgetPermissions, type WireValue, type Workspace } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import { PolicyError } from "../../data/policy.ts";
import { widgetRead, type WidgetIdentity } from "../../data/widgets.ts";
import { checkoutOf, worktreesOf } from "../../lib/checkout.ts";
import { gitDiff, gitStatus } from "../../lib/git.ts";
import { stripAnsi } from "../../terminals/commands.ts";
import type { PackageWidget, WidgetPackage } from "../package.ts";
import { ApiRefusal, RateLimit, failed, invalid, missing, workspaceScope } from "./access.ts";
import { widgetComplete, type AiUsage } from "./ai.ts";
import { apiAgent, apiEvent, apiTerminal, apiWindow, apiWorkspace, selectedIn } from "./model.ts";
import { brokeredFetch } from "./net.ts";
import { subscribeTopic } from "./topics.ts";
import { widgetActs, type ActDeps, type Press } from "./act.ts";
import { widgetRunner, type RunScope } from "./run.ts";

export type AdapterCore = Pick<CoreContext, "agents" | "panes" | "windows" | "windowTypes" | "workspaces" | "data" | "actions" | "notifications" | "ai" | "settings" | "broadcast" | "opened" | "call">;

/** The window a widget runs for, and what it may do. */
export interface WidgetScope {
  windowId: string;
  /** Its window's workspace now (a window can move). */
  workspaceId(): string;
  pkg: WidgetPackage;
  widget: PackageWidget;
  /** declared ∩ granted. */
  permissions: WidgetPermissions;
  /** The person's last press in the widget's tree (host/press.ts): an act or windows.open takes it, one per press. A frame's call brings its own. */
  press: Press;
  /** The tools' approvals and board marks the acts ask and show through; none: acts are refused. */
  acts?: () => ActDeps | null;
  /** Tests: what cmd.run runs instead of execArgv. */
  exec?: RunScope["exec"];
  /** A secret config field's value. */
  secret(key: string): string | null;
  aiUsage: AiUsage;
  fetchImpl?: typeof fetch;
}

/** One widget process's API: what its calls and subscriptions reach. */
export interface WidgetApi {
  /** The verbs it serves (`cmd.env.has`). */
  readonly verbs: ApiVerb[];
  /** A verb; throws ApiRefusal for a refused or failed one. `press`: a frame's (host/press.ts FramePress), else the window's. */
  call(verb: string, params: WireValue[], press?: Press): Promise<WireValue>;
  /** A live topic: `push` at once with the current value, then on each change; returns what stops it. */
  subscribe(topic: string, query: unknown, push: (data: WireValue) => void): () => void;
  /** The process is gone: its acts waiting for the person are a no, its session's yeses go. */
  dispose(): void;
}

/** windows.open is allowed this long after the person pressed something. */
export const OPEN_AFTER_PRESS_MS = 5000;
const SCREEN_MAX = 16 * 1024;
const DIFF_MAX = 256 * 1024;
const WAIT_MAX_MS = 60_000;
const FILES_MAX = 500;

/** Every verb but the acts, which act.ts plans. */
type Verbs = { [V in Exclude<ApiVerb, ApiActVerb>]: (...p: ApiMethods[V]["params"]) => ApiMethods[V]["result"] | Promise<ApiMethods[V]["result"]> };

export function widgetApi(core: AdapterCore, scope: WidgetScope): WidgetApi {
  const perms = scope.permissions;
  const level = workspaceScope(perms);
  const limits = { net: new RateLimit(60), ai: new RateLimit(10), notify: new RateLimit(10) };
  const sent = new Map<string, string>();

  /** The workspace part of a read: its own unless "all" was asked (and granted). */
  const allowed = (q?: ApiScopeQuery | null): "workspace" | "all" => {
    const all = q?.scope === "all";
    if (all && level !== "all") throw missing("workspace", "all", "Seeing every workspace");
    if (level === "none") throw missing("workspace", "read", "Seeing this workspace");
    return all ? "all" : "workspace";
  };
  const own = () => scope.workspaceId();
  const sees = (wsId: string, s: "workspace" | "all") => s === "all" || wsId === own();
  /** Whatever the query says, may this widget see things in `wsId` at all (by id lookups). */
  const visible = (wsId: string) => level === "all" || (level === "workspace" && wsId === own());
  const workspace = (): Workspace => {
    const ws = core.workspaces.get(own());
    if (!ws) throw failed("This widget's workspace is gone.");
    return ws;
  };
  const root = () => workspace().root;

  const agents = (q?: ApiScopeQuery | null) => {
    const s = allowed(q);
    return core.agents.list().filter((a) => sees(a.workspaceId, s)).map((a) => apiAgent(a, (id) => core.agents.get(id)));
  };
  const terminals = (q?: ApiScopeQuery | null) => {
    const s = allowed(q);
    return core.panes.list().filter((p) => sees(p.workspaceId, s)).map((p) => apiTerminal(p, core.panes.command(p.id)));
  };
  const windows = (q?: ApiScopeQuery | null) => {
    const s = allowed(q);
    return core.windows.list().filter((w) => sees(w.workspaceId, s)).map((w) => apiWindow(w, selectedIn(core.workspaces.get(w.workspaceId))));
  };
  const pane = (id: string) => {
    const p = typeof id === "string" ? core.panes.get(id) : null;
    if (!p || !visible(p.workspaceId)) throw invalid(`No terminal ${String(id).slice(0, 60)} in this widget's reach.`);
    return p;
  };

  const events = (q: ApiEventQuery | null | undefined): ApiEvent[] => {
    const query = q && typeof q === "object" ? q : {};
    const s = query.scope === "all" ? allowed(query) : "workspace";
    const ids = s === "all" ? core.workspaces.list().map((w) => w.id) : [own()];
    const dq: DataQuery = { ...(Array.isArray(query.types) ? { types: query.types } : {}), ...(query.since ? { at: [Number(query.since), Date.now() + 1] as [number, number] } : {}), limit: query.limit, order: "desc", by: "time" };
    const out: ApiEvent[] = [];
    for (const workspaceId of ids) out.push(...readEvents({ widgetId: scope.pkg.name, workspaceId, events: perms.events }, dq, core).map(apiEvent));
    const limit = Math.max(1, Math.min(Number(query.limit) || 200, 1000));
    return out.sort((a, b) => a.at - b.at || a.id - b.id).slice(-limit);
  };

  const git = async () => {
    allowed();
    const r = root();
    const st = r ? await gitStatus(r) : null;
    if (!st) return null;
    return { root: st.root, branch: st.branch, ahead: st.ahead, behind: st.behind, files: Object.entries(st.files).slice(0, FILES_MAX).map(([p, f]) => ({ path: path.relative(st.root, p) || ".", status: f.state })) };
  };
  const actions = () => {
    allowed();
    const r = root();
    if (!r) return [];
    return core.actions.list(r).actions.map((a) => ({ name: a.name, title: a.description ?? a.command, risky: a.risky }));
  };
  const win = (): AppWindow => {
    const w = core.windows.others().find((x) => x.id === scope.windowId);
    if (!w) throw failed("This widget's window is gone.");
    return w;
  };
  const kv = () => ({ ...((win().state.kv as Record<string, WireValue> | undefined) ?? {}) });
  const acts = widgetActs(core, {
    windowId: scope.windowId,
    workspaceId: own,
    pkg: scope.pkg,
    widget: scope.widget,
    permissions: perms,
    press: scope.press,
    deps: () => scope.acts?.() ?? null,
  });
  const run = widgetRunner({ permissions: perms, root: () => core.workspaces.get(own())?.root ?? null, exec: scope.exec });

  /** windows.open, after the press it takes: one window per press. */
  const open = (target: unknown, press: Press) => {
    if (Date.now() - press.at() > OPEN_AFTER_PRESS_MS) throw invalid("windows.open works right after the person presses something in the widget.");
    if (typeof target !== "string" || !target.trim()) throw invalid("windows.open: name a URL, a path or a widget");
    press.take(); // one window per press
    const ws = workspace();
    const type = parsePackageKind(target) || core.windowTypes.get(target)?.role === "widget" ? core.windowTypes.get(target) : null;
    const w = type ? core.windows.open(type.kind, {}, ws) : core.windows.openTarget(target.trim(), ws);
    if (!w) throw invalid(`cmd can't open "${target.slice(0, 120)}" in a window`);
    core.opened(w);
    return { id: w.id };
  };

  const VERBS: Verbs = {
    "workspace.get": () => {
      allowed();
      const ws = workspace();
      return apiWorkspace(ws, ws.root ? (checkoutOf(ws.root)?.branch ?? null) : null);
    },
    "workspace.windows": () => windows(),
    "workspace.selected": () => {
      allowed();
      const id = selectedIn(core.workspaces.get(own()));
      const w = id ? core.windows.list().find((x) => x.id === id) : undefined;
      return w ? apiWindow(w, id) : null;
    },
    "agents.list": (q) => agents(q),
    "agents.get": (id) => {
      allowed();
      const a = typeof id === "string" ? core.agents.get(id) : null;
      return a && visible(a.workspaceId) ? apiAgent(a, (x) => core.agents.get(x)) : null;
    },
    "terminals.list": (q) => terminals(q),
    "terminals.read": async (id, opts) => {
      allowed();
      const p = pane(id);
      const lines = Math.max(1, Math.min(Math.floor(Number(opts?.lines) || 50), 200));
      let text = await core.panes.read(p.id, lines);
      const cut = text.length > SCREEN_MAX;
      if (cut) text = text.slice(-SCREEN_MAX);
      return { text, clipped: cut || text.split("\n").length >= lines, untrusted: true };
    },
    "terminals.waitFor": (id, pattern, opts) => {
      allowed();
      const p = pane(id);
      let re: RegExp;
      try {
        re = new RegExp(String(pattern));
      } catch {
        throw invalid(`terminals.waitFor: "${String(pattern).slice(0, 80)}" isn't a regular expression`);
      }
      return waitForLine(core, p.id, re, Math.max(0, Math.min(Number(opts?.timeoutMs) || 30_000, WAIT_MAX_MS)));
    },
    "windows.list": (q) => windows(q),
    "windows.open": (target) => open(target, scope.press),
    "windows.select": (id) => {
      const w = typeof id === "string" ? core.windows.list().find((x) => x.id === id) : undefined;
      if (!w || !(w.workspaceId === own() || level === "all")) throw invalid(`No window ${String(id).slice(0, 60)} in this widget's reach.`);
      core.broadcast({ type: "window.focus", id: w.id });
      return null;
    },
    "events.query": (q) => events(q),
    "events.stats": (q) => {
      const list = events({ ...(q ?? {}), limit: 1000 });
      const byType: Record<string, number> = {};
      for (const e of list) byType[e.type] = (byType[e.type] ?? 0) + 1;
      return { total: list.length, byType };
    },
    "git.status": () => git(),
    "git.diff": async (file) => {
      allowed();
      const r = root();
      if (file !== undefined && file !== null && (typeof file !== "string" || path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))) throw invalid("git.diff: name a file inside the repository, relative to it");
      const d = r ? await gitDiff(r, file ?? undefined) : null;
      if (!d) return { text: "", clipped: false };
      return { text: d.diff.slice(0, DIFF_MAX), clipped: d.truncated || d.diff.length > DIFF_MAX };
    },
    "git.worktrees": () => {
      allowed();
      const r = root();
      const c = r ? checkoutOf(r) : null;
      if (!c) return [];
      return [c.repo, ...worktreesOf(c.common).filter((t) => t !== c.repo)].map((top) => ({ path: top, branch: checkoutOf(top)?.branch ?? null, main: top === c.repo }));
    },
    "actions.list": () => actions(),
    "notify.send": (note: ApiNotification) => {
      if (!note || typeof note.key !== "string" || !note.key || typeof note.title !== "string" || !note.title.trim()) throw invalid("notify.send: give it a key and a title ({ key, title, body })");
      const body = typeof note.body === "string" ? note.body.slice(0, 300) : "";
      const title = note.title.slice(0, 120);
      const same = `${title}\n${body}`;
      if (sent.get(note.key) === same) return null; // the same key and words: told already
      limits.notify.take("notify.send");
      sent.set(note.key.slice(0, 200), same);
      core.notifications.widget({ windowId: scope.windowId, title, body, urgent: note.urgent !== false, muted: !!win().state.muted });
      return null;
    },
    "state.get": (key) => kv()[String(key)] ?? null,
    "state.set": (key, value) => {
      if (typeof key !== "string" || !key || key.length > 200) throw invalid("state.set: the key should be a short string");
      const next = kv();
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
      if (JSON.stringify(next).length > 256 * 1024) throw failed("This widget's stored state is full (256 KB).");
      core.windows.update(scope.windowId, { state: { kv: next } });
      return null;
    },
    "state.history": (key, value, max) => {
      if (typeof key !== "string" || !key || key.length > 200) throw invalid("state.history: the key should be a short string");
      const keep = Math.max(1, Math.min(Math.floor(Number(max) || 60), 1000));
      const all = { ...((win().state.series as Record<string, number[]> | undefined) ?? {}) };
      const list = [...(all[key] ?? [])];
      if (typeof value === "number" && Number.isFinite(value)) {
        list.push(value);
        all[key] = list.slice(-1000);
        core.windows.update(scope.windowId, { state: { series: all } });
      }
      return list.slice(-keep);
    },
    "net.fetch": (url, init) => {
      limits.net.take("net.fetch");
      return brokeredFetch(url, init, { net: perms.net, fields: scope.widget.config, secret: scope.secret, fetchImpl: scope.fetchImpl });
    },
    "ai.complete": (req) => {
      limits.ai.take("ai.complete");
      return widgetComplete(req, { name: scope.pkg.name, budget: () => Number(core.settings.settings["widgets.aiBudget"]) || 0, ai: core.ai }, scope.aiUsage);
    },
    // 1.1: cmd.run runs read-only commands through the core (run.ts).
    "run.exec": (program, args, opts) => run(program, args, opts) as never,
  };

  /** A topic's read: its verb, the row already checked (topics.ts). */
  const read = (verb: ApiVerb, q: unknown): unknown => (VERBS[verb as keyof Verbs] as (q: unknown) => unknown)(q);

  return {
    verbs: [...API_VERBS],
    async call(verb, params, press = scope.press) {
      if (!(API_VERBS as readonly string[]).includes(verb)) throw new ApiRefusal({ code: "unknown", message: `This cmd doesn't serve ${String(verb).slice(0, 60)}.` });
      const v = verb as ApiVerb;
      const p = Array.isArray(params) ? params : [];
      // The row first: what the verb needs at all; net hosts, event classes and "all" are checked per call.
      const needs = API[v].needs;
      if (needs === "workspace" && level === "none") throw missing("workspace", "read", "Seeing this workspace");
      if (needs === "ai" && !perms.ai.includes(v.split(".")[1]!)) throw missing("ai", v.split(".")[1]!, "Using cmd's AI");
      // An act: act.ts checks its grant, the press, its scope, and asks.
      if (isActVerb(v)) return acts.call(v, p, press);
      if (v === "windows.open") return open(p[0], press);
      const fn = VERBS[v] as (...p: WireValue[]) => unknown;
      return ((await fn(...p)) ?? null) as WireValue;
    },
    dispose() {
      acts.dispose();
    },
    subscribe(topic, query, push) {
      const verb = topicVerb(topic);
      if (verb && API[verb].needs === "workspace" && level === "none") throw missing("workspace", "read", "Seeing this workspace");
      return subscribeTopic(core, { topic: topic as ApiTopic, query, own, read, perms, root: () => core.workspaces.get(own())?.root ?? null }, push);
    },
  };
}

/** A widget's read of the log within data/policy.ts, a refused class named as the permission to add. */
export function readEvents(id: WidgetIdentity, q: DataQuery, core: Pick<CoreContext, "data">): ReturnType<typeof widgetRead> {
  try {
    return widgetRead(id, q, (x) => core.data.query(x));
  } catch (e) {
    if (!(e instanceof PolicyError)) throw e;
    if (e.class) throw missing("events", e.class, `Reading ${e.type ? `"${e.type}"` : "these"} events`);
    throw invalid(e.message.replace(/^events: /, "events.query: "));
  }
}

/** Resolves when a line of the terminal matches, or after `ms`. */
function waitForLine(core: Pick<CoreContext, "panes">, paneId: string, re: RegExp, ms: number): Promise<{ matched: boolean; line: string | null }> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (line: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      core.panes.off("output", onOutput);
      core.panes.off("removed", onRemoved);
      resolve({ matched: line !== null, line });
    };
    const onOutput = (id: string, data: string) => {
      if (id !== paneId) return;
      buf = (buf + stripAnsi(data)).slice(-8192);
      const lines = buf.split(/\r?\n/);
      for (const l of lines) if (re.test(l)) return finish(l);
      buf = lines.at(-1) ?? "";
    };
    const onRemoved = (id: string) => id === paneId && finish(null);
    const timer = setTimeout(() => finish(null), ms);
    core.panes.on("output", onOutput);
    core.panes.on("removed", onRemoved);
    void core.panes.read(paneId, 50).then((screen) => {
      for (const l of screen.split("\n")) if (re.test(l)) return finish(l);
    }, () => {});
  });
}

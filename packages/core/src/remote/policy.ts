// What a paired device may do (docs/13-remote-access.md, "Scopes and the policy
// table"). Fail-closed: every RPC method has an explicit entry (tsc refuses a new
// method until someone decides), anything not allowed is denied, and arguments
// are checked too: panes, agents and windows must belong to an open workspace, paths
// must resolve (symlinks followed) inside the root of an open workspace other than
// Home (which is the whole home folder) and off the private paths (paths-deny.ts:
// credentials, cmd's own state, agents' transcripts). Events go through an
// allowlist as well.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, AppWindow, CoreEvent, Method, Pane, Params, RemoteScope, Result, Workspace } from "@cmd/protocol";
import { refusedStatement } from "../sqlite/statements.ts";
import { expandPath, inCmdInstance, isDeniedPath, remotePrivatePaths } from "../lib/paths-deny.ts";
import type { AgentTracker } from "../agents/tracker.ts";
import type { PaneManager } from "../terminals/panes.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";
import type { WindowManager } from "../windows/index.ts";
import type { WindowTypes } from "../windows/types.ts";
import { validEndpoint } from "./webpush.ts";
import { withoutHandlers } from "@cmd/protocol/widget-tree";

/** view: any paired device; control: control-scope devices; never: only the Mac. */
export type Access = "view" | "control" | "never";

export const REMOTE_ACCESS: { [M in Method]: Access } = {
  "core.hello": "view",
  "core.info": "never", // paths, sockets, process details
  "core.processes": "never", // Task Manager diagnostics
  "usage.launch": "never", // the app's own launches only
  "pane.create": "control", // no more power than typing into an existing terminal
  "pane.list": "view",
  "pane.write": "control",
  "pane.resize": "never", // the desktop owns sizes; phones use pane.fitOverride
  "pane.fitOverride": "control", // temporary; ends when the phone leaves, disconnects, or the Mac types
  "pane.reclaim": "never",
  "pane.kill": "control",
  "pane.setMuted": "control",
  "pane.clearAttention": "view",
  "window.clearAttention": "view",
  "notify.send": "never",
  "notify.clear": "never",
  "pane.snapshot": "view",
  "pane.reset": "control",
  "pane.read": "view",
  "pane.waitFor": "view",
  "agent.list": "view",
  "agent.spawn": "control",
  "agent.send": "control",
  "agent.wait": "never",
  "agent.kill": "control",
  "agent.rename": "control",
  "agent.markSeen": "view",
  // Raw events and turns carry prompts, commands and paths: local only for now.
  "agent.summarize": "never",
  "agents.coverage": "never",
  // The journal holds prompts, commands and pages: local only.
  "journal.days": "never",
  "journal.day": "never",
  "journal.history": "never",
  "journal.week": "never",
  "journal.events": "never",
  "journal.threads": "never",
  "journal.note": "never",
  "journal.sync": "never",
  "agents.homes": "never",
  // The event log holds prompts, commands, pages and output: local only.
  "data.query": "never",
  "data.stats": "never",
  "data.explain": "never",
  "data.record": "never",
  "data.import": "never",
  "data.subscribe": "never",
  "widget.hello": "never",
  "data.unsubscribe": "never",
  "data.view": "never",
  "data.subscribeView": "never",
  "data.forget": "never",
  "data.rebuild": "never",
  "data.entities": "never",
  "data.applyRules": "never",
  "agents.export": "never",
  "hook.ingest": "never",
  "hooks.status": "never",
  "hooks.install": "never",
  "hooks.remove": "never",
  identify: "never",
  "settings.get": "never",
  "settings.set": "never",
  "settings.reset": "never",
  "secrets.status": "never",
  "secrets.set": "never",
  "ai.status": "never",
  "ai.connect": "never",
  "ai.models": "never",
  "window.open": "control",
  "window.update": "control",
  "window.types": "view",
  "window.close": "control",
  "window.select": "control",
  "browser.read": "never", // pages may hold what the Mac is signed in to
  "browser.reply": "never",
  "browser.act": "never",
  "browser.acted": "never",
  "workspace.arrange": "never",
  "workspace.arranged": "never",
  "window.closed": "never",
  "window.reopen": "never",
  "window.openTarget": "never",
  "window.move": "never",
  "window.list": "view",
  "window.follow": "view",
  "workspace.list": "view",
  "workspace.open": "never",
  "workspace.match": "never",
  "workspace.update": "never", // a phone's layout is its own, never Workspace.view
  "workspace.close": "never",
  "workspace.forget": "never",
  "magic.run": "control", // spends API keys, runs the exploring agent
  "jam.change": "control", // spends API keys; returns code, runs nothing
  "magic.cancel": "control",
  "magic.editPackage": "never",
  "magic.package": "never", // file paths
  "magic.restorePackage": "never",
  "magic.runtime": "never",
  "magic.installRuntime": "never",
  "magic.skipRuntime": "never",
  "magic.previewer": "never",
  "magic.previewResult": "never",
  "widget.list": "never", // file paths (screenshots)
  "widget.add": "never",
  "widget.delete": "never",
  // widget packages (docs/56): a press reaches the Mac from a control-scope device; trees reach a device that follows the window, without handlers below control scope (remoteEvent, withoutHandlers)
  "widget.interact": "control",
  "widget.resync": "never",
  "widget.env": "never",
  "widget.restart": "never",
  "widget.ask": "never", // the person is asked, by the person
  "widget.grant": "never", // a person's answer, never a tool's or a device's
  "widget.config": "never", // the Mac's Configure sheet
  "widget.secret": "never", // secrets are typed on the Mac
  "widget.secrets": "never",
  "widget.frameSource": "never", // the app's frame host
  "widget.frame": "never", // a frame's calls, after the app's own checks
  "widget.frameSubscribe": "never", // a frame's live topics, to the app's connection
  "widget.frameUnsubscribe": "never",
  "fs.list": "view",
  "fs.resolve": "never", // an existence oracle for any path; the web client resolves terminal links within workspaces later
  "fs.read": "view",
  "fs.watch": "view",
  "fs.unwatch": "view",
  "fs.write": "control",
  "fs.rename": "control",
  "fs.duplicate": "control",
  "fs.create": "control",
  "fs.transfer": "control",
  "video.trim": "never", // runs avconvert on a file
  "git.status": "view",
  "git.diff": "view",
  "git.worktrees": "never",
  "git.fileVersions": "never",
  "actions.list": "never", // Workspace Actions are the Mac's for now (docs/39)
  "actions.run": "never",
  "actions.stop": "never",
  "actions.pin": "never",
  "stats.catalog": "never", // stats name commands and hosts; remote gets them with per-class filtering (docs/49)
  "stats.query": "never",
  "nowPlaying.get": "never",
  "nowPlaying.control": "never",
  "stats.queryMany": "never",
  "stats.rebuild": "never",
  "operator.get": "never", // the Operator is the Mac's for now (docs/51)
  "operator.send": "never",
  "operator.stop": "never",
  "operator.reset": "never",
  "operator.history": "never",
  "operator.open": "never",
  "tools.list": "never",
  "tools.call": "never",
  "approvals.waiting": "never",
  "approvals.answer": "never",
  "approvals.list": "never",
  "approvals.forget": "never",
  "approvals.allow": "never",
  "approvals.denied": "never",
  "sqlite.schema": "view",
  "sqlite.rows": "view",
  "sqlite.query": "view",
  "sqlite.export": "never", // writes a file where it's told to
  "search.query": "never",
  "search.files": "never",
  "search.history": "never",
  "search.status": "never",
  "search.reindex": "never",
  "agent.resumeCommand": "never",
  "agent.resume": "never",
  "ui.get": "never",
  "ui.set": "never",
  "events.subscribe": "never", // remote sessions use remote.bootstrap
  "remote.status": "never", // a phone can never manage remote access or pairing
  "remote.enable": "never",
  "remote.disable": "never",
  "remote.pair": "never",
  "remote.approve": "never",
  "remote.devices": "never",
  "remote.disconnect": "never",
  "remote.log": "never",
  "remote.modes": "never",
  "remote.checks": "never",
  "remote.setup": "never",
  "remote.revoke": "never",
  "remote.setScope": "never",
  "remote.bootstrap": "view",
  "remote.ack": "view",
  "push.subscribe": "view", // notifications are about what view scope already shows
  "push.unsubscribe": "view",
  "push.visible": "view",
  "ui.presence": "never", // the Mac's own app
};

export class RemoteDenied extends Error {}

export interface PolicyContext {
  panes: PaneManager;
  agents: AgentTracker;
  workspaces: WorkspaceManager;
  windows: WindowManager;
  /** For what each window type lets a device see of its state (remoteState); none without. */
  windowTypes?: Pick<WindowTypes, "get">;
  home?: string;
  /** Private paths only the core knows (agent homes and transcript folders it found), on top of remotePrivatePaths(). */
  private?: () => readonly string[];
}

/** Writes and messages from a phone. */
export const MAX_WRITE = 64 * 1024;
/** Paths one remote session may watch at a time (fs.watch). */
export const MAX_WATCHES = 32;

/** Reachable methods whose params are empty: nothing to check. Every other reachable method has an ARGS entry (remote-policy.test.ts). */
export const NO_ARGS: ReadonlySet<Method> = new Set<Method>(["core.hello", "pane.list", "agent.list", "window.types", "window.list", "workspace.list", "remote.bootstrap", "push.unsubscribe"]);

type Check<M extends Method> = (p: Params<M>, ctx: PolicyContext) => void;
const ARGS: { [M in Method]?: Check<M> } = {
  "push.subscribe": (p) => {
    if (typeof p.endpoint !== "string" || !validEndpoint(p.endpoint)) throw new RemoteDenied("not a push service this Mac sends to");
    const k = p.keys as { p256dh?: unknown; auth?: unknown } | undefined;
    if (typeof k?.p256dh !== "string" || typeof k.auth !== "string" || k.p256dh.length > 100 || k.auth.length > 40) throw new RemoteDenied("bad subscription keys");
  },
  "push.visible": (p) => {
    if (typeof p.visible !== "boolean") throw new RemoteDenied("visible must be true or false");
  },
  "pane.create": (p, ctx) => {
    if (p.workspaceId) openWorkspace(ctx, p.workspaceId);
    if (p.callerPaneId) pane(ctx, p.callerPaneId);
    if (p.cwd !== undefined) allowedPath(ctx, p.cwd);
  },
  "pane.write": (p, ctx) => {
    pane(ctx, p.paneId);
    text(p.data);
  },
  "pane.kill": (p, ctx) => pane(ctx, p.paneId),
  "pane.fitOverride": (p, ctx) => {
    pane(ctx, p.paneId);
    if ("release" in p) return;
    const ok = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
    if (!ok(p.cols, 20, 300) || !ok(p.rows, 5, 200)) throw new RemoteDenied("size out of range");
  },
  "pane.setMuted": (p, ctx) => pane(ctx, p.paneId),
  "pane.clearAttention": (p, ctx) => pane(ctx, p.paneId),
  "pane.snapshot": (p, ctx) => pane(ctx, p.paneId),
  "pane.reset": (p, ctx) => pane(ctx, p.paneId),
  "pane.read": (p, ctx) => pane(ctx, p.paneId),
  "pane.waitFor": (p, ctx) => pane(ctx, p.paneId),
  "agent.spawn": (p, ctx) => {
    if (p.workspaceId) openWorkspace(ctx, p.workspaceId);
    if (p.callerPaneId) pane(ctx, p.callerPaneId);
    if (p.parentId) agent(ctx, p.parentId);
    if (p.cwd !== undefined) allowedPath(ctx, p.cwd);
    if (p.prompt !== undefined) text(p.prompt);
  },
  "agent.send": (p, ctx) => {
    agent(ctx, p.agentId);
    text(p.text);
  },
  "agent.kill": (p, ctx) => agent(ctx, p.agentId),
  "agent.rename": (p, ctx) => {
    agent(ctx, p.agentId);
    if (p.name !== null) text(p.name);
  },
  "agent.markSeen": (p, ctx) => agent(ctx, p.agentId),
  "window.open": (p, ctx) => {
    if (p.workspaceId) openWorkspace(ctx, p.workspaceId);
    if (p.callerPaneId) pane(ctx, p.callerPaneId);
    for (const k of ["path", "cwd"]) {
      const v = p.input?.[k];
      if (v !== undefined) allowedPath(ctx, v);
    }
  },
  "window.update": (p, ctx) => {
    window(ctx, p.id);
    if (p.kind !== undefined) throw new RemoteDenied("can't change a window's type remotely");
    if (JSON.stringify(p.state ?? null).length > MAX_WRITE) throw new RemoteDenied("state too large");
  },
  "window.close": (p, ctx) => window(ctx, p.id),
  "window.select": (p, ctx) => window(ctx, p.id),
  "window.clearAttention": (p, ctx) => window(ctx, p.id),
  "window.follow": (p, ctx) => {
    if (!Array.isArray(p.ids) || p.ids.length > 64) throw new RemoteDenied("follow up to 64 windows");
    for (const id of p.ids) window(ctx, id);
  },
  "magic.run": (p, ctx) => {
    magicWidget(ctx, p.id);
    text(p.prompt);
  },
  "widget.interact": (p, ctx) => {
    window(ctx, p.windowId);
    if (!Number.isInteger(p.handler) || typeof p.event !== "string" || p.event.length > 64) throw new RemoteDenied("not an interaction");
    if (JSON.stringify(p.value ?? null).length > MAX_WRITE) throw new RemoteDenied("value too large");
  },
  "magic.cancel": (p, ctx) => magicWidget(ctx, p.id),
  "jam.change": (p) => {
    text(p.code);
    text(p.request);
    if (p.sounds !== undefined && (!Array.isArray(p.sounds) || p.sounds.length > 500)) throw new RemoteDenied("too many sounds");
    for (const s of p.sounds ?? []) if (typeof s !== "string" || s.length > 200) throw new RemoteDenied("bad sound");
    if (p.history !== undefined && (!Array.isArray(p.history) || p.history.length > 20)) throw new RemoteDenied("too much history");
    for (const h of p.history ?? []) [h.code, h.request, h.summary].forEach(text);
    if (p.failed !== undefined) [p.failed.code, p.failed.error].forEach(text);
  },
  "remote.ack": (p) => {
    if (typeof p.received !== "number" || !Number.isFinite(p.received) || p.received < 0) throw new RemoteDenied("bad count");
  },
  "fs.list": (p, ctx) => allowedPath(ctx, p.path),
  "fs.read": (p, ctx) => allowedPath(ctx, p.path),
  "fs.watch": (p, ctx) => allowedPath(ctx, p.path),
  "fs.unwatch": (p, ctx) => allowedPath(ctx, p.path),
  "fs.write": (p, ctx) => {
    allowedPath(ctx, p.path);
    if (typeof p.text !== "string" || p.text.length > 5 * 1024 * 1024) throw new RemoteDenied("file too large");
  },
  "fs.rename": (p, ctx) => {
    allowedPath(ctx, p.path);
    if (typeof p.name !== "string" || !p.name || /[/\0]/.test(p.name)) throw new RemoteDenied("bad name");
    allowedPath(ctx, path.join(path.dirname(p.path), p.name)); // e.g. not to .env
  },
  "fs.duplicate": (p, ctx) => allowedPath(ctx, p.path),
  "fs.create": (p, ctx) => allowedPath(ctx, p.dir),
  "fs.transfer": (p, ctx) => {
    if (!Array.isArray(p.paths) || !["copy", "move", "auto"].includes(p.op)) throw new RemoteDenied("bad transfer");
    allowedPath(ctx, p.dir);
    for (const f of p.paths) {
      allowedPath(ctx, f);
      allowedPath(ctx, path.join(p.dir, path.basename(f))); // what it becomes there, e.g. not a .env
    }
  },
  "git.status": (p, ctx) => allowedPath(ctx, p.path),
  "git.diff": (p, ctx) => {
    allowedPath(ctx, p.path);
    if (p.file !== undefined) allowedPath(ctx, path.resolve(p.path, p.file));
  },
  "sqlite.schema": (p, ctx) => allowedPath(ctx, p.path),
  "sqlite.rows": (p, ctx) => allowedPath(ctx, p.path),
  "sqlite.query": (p, ctx) => {
    allowedPath(ctx, p.path);
    text(p.sql);
    const refused = refusedStatement(p.sql); // the worker refuses these too
    if (refused) throw new RemoteDenied(refused);
  },
};

export function scopeAllows(scope: RemoteScope, access: Access): boolean {
  return access === "view" || (access === "control" && scope === "control");
}

/** Throws RemoteDenied unless a device of `scope` may make this call. */
export function checkRemoteCall(method: string, params: unknown, scope: RemoteScope, ctx: PolicyContext): void {
  const access = Object.hasOwn(REMOTE_ACCESS, method) ? REMOTE_ACCESS[method as Method] : "never";
  if (!scopeAllows(scope, access)) throw new RemoteDenied(access === "control" ? `${method} needs control access` : `${method} isn't available remotely`);
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new RemoteDenied("bad params");
  (ARGS[method as Method] as Check<Method> | undefined)?.(params as never, ctx);
}

// ── argument checks ───────────────────────────────────

function text(v: unknown): void {
  if (typeof v !== "string") throw new RemoteDenied("expected text");
  if (v.length > MAX_WRITE) throw new RemoteDenied("too long");
}

function openWorkspace(ctx: PolicyContext, id: unknown): void {
  const s = typeof id === "string" ? ctx.workspaces.get(id) : undefined;
  if (!s || s.closedAt !== null) throw new RemoteDenied("no such workspace");
}

function pane(ctx: PolicyContext, id: unknown): void {
  const p = typeof id === "string" ? ctx.panes.get(id) : null;
  if (!p) throw new RemoteDenied("no such terminal");
  openWorkspace(ctx, p.workspaceId);
}

function agent(ctx: PolicyContext, id: unknown): void {
  const a = typeof id === "string" ? ctx.agents.get(id) : null;
  if (!a) throw new RemoteDenied("no such agent");
  openWorkspace(ctx, a.workspaceId);
}

function window(ctx: PolicyContext, id: unknown): void {
  const w = typeof id === "string" ? ctx.windows.list().find((x) => x.id === id) : undefined;
  if (!w) throw new RemoteDenied("no such window");
  openWorkspace(ctx, w.workspaceId);
}

function magicWidget(ctx: PolicyContext, id: unknown): void {
  window(ctx, id);
  if (ctx.windows.list().find((x) => x.id === id)?.kind !== "magic") throw new RemoteDenied("not a Magic widget");
}

/**
 * The real path (symlinks resolved; for a file that doesn't exist yet, its
 * folder's) must be inside an open workspace's root, Home's excepted, and not a
 * private file.
 */
export function allowedPath(ctx: PolicyContext, p: unknown): string {
  if (typeof p !== "string" || !p || p.includes("\0")) throw new RemoteDenied("bad path");
  if (!path.isAbsolute(p) && p !== "~" && !p.startsWith("~/")) throw new RemoteDenied("paths must be absolute");
  const home = ctx.home ?? os.homedir();
  const abs = path.resolve(p.startsWith("~") ? path.join(home, p.slice(1)) : p);
  const real = realpath(abs);
  const roots = ctx.workspaces
    .list()
    .filter((s) => !s.home)
    .map((s) => realpath(s.root));
  if (!roots.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) throw new RemoteDenied("outside your workspaces");
  // Each private path as written and as its real path (CMD_HOME under /var is /private/var).
  const deny = [...remotePrivatePaths(), ...(ctx.private?.() ?? [])].flatMap((d) => {
    const e = path.resolve(expandPath(d, home));
    const r = realpath(e);
    return r === e ? [e] : [e, r];
  });
  if (isDeniedPath(real, deny, home) || isDeniedPath(abs, deny, home) || inCmdInstance(real) || inCmdInstance(abs)) throw new RemoteDenied("a private file");
  return real;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    // Doesn't exist (yet): resolve its folder, keep the name.
    const dir = path.dirname(p);
    return dir === p ? p : path.join(realpath(dir), path.basename(p));
  }
}

// ── what a device is told ────────────────────────────

/**
 * What a paired device sees of the Mac, by the rule its calls are held to: what's
 * in an open workspace (Home's terminals included; its files aren't, allowedPath).
 * Agents without the person's prompts (lastPrompt, the spawn prompt: words meant for
 * a model; a device names agents by their names), windows with only the state their
 * type lets out (WindowType.remoteState; none by default). remote.bootstrap, the
 * *.list methods and every event go through it (kernel/server.ts).
 */
const inOpen = (ctx: PolicyContext, workspaceId: string) => {
  const s = ctx.workspaces.get(workspaceId);
  return !!s && s.closedAt === null;
};
export const remoteAgent = (a: Agent): Agent => ({ ...a, lastPrompt: null, spawn: { source: a.spawn.source } });
export const remoteWindow = (w: AppWindow, ctx: PolicyContext): AppWindow => ({ ...w, state: (ctx.windowTypes?.get(w.kind)?.remoteState?.(w.state as never) ?? {}) as AppWindow["state"] });

/** A method's result as a device gets it. */
export function remoteResult(method: string, r: unknown, ctx: PolicyContext): unknown {
  const panes = (l: Pane[]) => l.filter((p) => inOpen(ctx, p.workspaceId));
  const agents = (l: Agent[]) => l.filter((a) => inOpen(ctx, a.workspaceId)).map(remoteAgent);
  const windows = (l: AppWindow[]) => l.filter((w) => inOpen(ctx, w.workspaceId)).map((w) => remoteWindow(w, ctx));
  const workspaces = (l: Workspace[]) => l.filter((s) => s.closedAt === null);
  switch (method) {
    case "pane.list":
      return panes(r as Pane[]);
    case "agent.list":
      return agents(r as Agent[]);
    case "window.list":
      return windows(r as AppWindow[]);
    case "workspace.list":
      return workspaces(r as Workspace[]);
    case "remote.bootstrap": {
      const b = r as Result<"remote.bootstrap">;
      return { ...b, panes: panes(b.panes), agents: agents(b.agents), windows: windows(b.windows), workspaces: workspaces(b.workspaces) };
    }
    default:
      return r;
  }
}

/**
 * An event as a device gets it, or null when it isn't told (remoteEventVisible, then what's outside open workspaces).
 * `scope`: the device's; a widget's tree reaches anything short of control scope without its handlers.
 */
export function remoteEvent(e: CoreEvent, ctx: PolicyContext, follows: ReadonlySet<string>, watches: readonly string[], scope?: RemoteScope): CoreEvent | null {
  if (!remoteEventVisible(e, follows, watches)) return null;
  switch (e.type) {
    case "widget.tree":
      return scope === "control" ? e : { ...e, message: withoutHandlers(e.message) };
    case "pane.updated":
      return inOpen(ctx, e.pane.workspaceId) ? e : null;
    case "agent.updated":
      return inOpen(ctx, e.agent.workspaceId) ? { ...e, agent: remoteAgent(e.agent) } : null;
    case "window.updated":
      return inOpen(ctx, e.window.workspaceId) ? { ...e, window: remoteWindow(e.window, ctx) } : null;
    case "workspace.updated":
      // Closed: gone, as far as a device knows (its terminals' removals follow).
      return e.workspace.closedAt === null ? e : { type: "workspace.removed", id: e.workspace.id };
    default:
      return e;
  }
}

// ── events ────────────────────────────────────────────

/**
 * Which events a remote session receives. Output and Magic data only for the
 * windows it follows, file changes only for paths it watches; never settings,
 * secrets, search, UI-only events or anything about remote access itself.
 */
export function remoteEventVisible(e: CoreEvent, follows: ReadonlySet<string>, watches: readonly string[]): boolean {
  switch (e.type) {
    case "pane.output":
      return follows.has(e.paneId);
    case "magic.stream":
      return follows.has(e.id);
    case "widget.tree":
      return follows.has(e.windowId);
    case "fs.changed":
      return watches.some((w) => e.path === w || e.path.startsWith(w.endsWith("/") ? w : w + "/"));
    case "pane.updated":
    case "pane.removed":
    case "agent.updated":
    case "agent.removed":
    case "window.updated": // its state stripped (remoteEvent)
    case "window.removed":
    case "workspace.updated":
    case "workspace.removed":
    case "notification":
    case "pane.resync":
    case "theme.updated": // theme ids only, not the rest of the settings
      return true;
    case "settings.updated":
    case "secrets.updated":
    case "ai.updated":
    case "search.status":
    case "core.startup": // this Mac's business (its sidebar footer)
    case "workspace.show":
    case "window.focus":
    case "remote.updated":
    case "remote.pairRequest":
    case "remote.pairEnded":
    case "remote.input":
    case "widget.library":
    case "widget.log": // a widget's console, for cmd widget dev on this Mac
    case "widget.frameEvent": // a frame's subscription, to the Mac's app connection that made it
    case "window.closedChanged": // window.closed and window.reopen aren't remote
    case "actions.changed":
    case "stats.changed":
    case "nowPlaying.changed":
    case "operator.changed":
    case "tool.acting": // approvals are answered on this Mac
    case "browser.request": // to the Mac's app windows only
    case "workspace.arrangeRequest":
    case "browser.actRequest":
    case "data.changed": // to its subscriber only, and data.* is never remote
    case "view.changed":
    case "magic.previewRequest": // sent to the app's previewer only, never broadcast
      return false;
    default: {
      const never: never = e;
      return !!never && false;
    }
  }
}

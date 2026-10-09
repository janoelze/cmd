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
import type { CoreEvent, Method, Params, RemoteScope } from "@cmd/protocol";
import { refusedStatement } from "../sqlite/statements.ts";
import { expandPath, inCmdInstance, isDeniedPath, remotePrivatePaths } from "../paths-deny.ts";
import type { AgentTracker } from "../agents/tracker.ts";
import type { PaneManager } from "../panes.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";
import type { WindowManager } from "../windows/index.ts";

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
  "magic.refresh": "view", // re-runs an already approved, read-only source
  "magic.setRefresh": "never",
  "magic.media": "never",
  "magic.widget": "never", // file paths and config
  "magic.restore": "never",
  "magic.config": "never",
  "magic.secret": "never",
  "magic.state": "never",
  "magic.fix": "never", // spends API keys; from the Mac only for now
  "magic.mute": "never",
  "magic.runtime": "never",
  "magic.installRuntime": "never",
  "magic.skipRuntime": "never",
  "magic.previewer": "never",
  "magic.previewResult": "never",
  "widget.list": "never", // file paths (screenshots)
  "widget.add": "never",
  "widget.rename": "never",
  "widget.duplicate": "never",
  "widget.delete": "never",
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
  "git.status": "view",
  "git.diff": "view",
  "actions.list": "never", // Workspace Actions are the Mac's for now (docs/39)
  "actions.run": "never",
  "actions.stop": "never",
  "actions.pin": "never",
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
  "remote.checks": "never",
  "remote.setup": "never",
  "remote.revoke": "never",
  "remote.setScope": "never",
  "remote.bootstrap": "view",
};

export class RemoteDenied extends Error {}

export interface PolicyContext {
  panes: PaneManager;
  agents: AgentTracker;
  workspaces: WorkspaceManager;
  windows: WindowManager;
  home?: string;
  /** Private paths only the core knows (agent homes and transcript folders it found), on top of remotePrivatePaths(). */
  private?: () => readonly string[];
}

/** Writes and messages from a phone. */
export const MAX_WRITE = 64 * 1024;

type Check<M extends Method> = (p: Params<M>, ctx: PolicyContext) => void;
const ARGS: { [M in Method]?: Check<M> } = {
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
  "window.clearAttention": (p, ctx) => window(ctx, p.id),
  "window.follow": (p, ctx) => {
    if (!Array.isArray(p.ids) || p.ids.length > 64) throw new RemoteDenied("follow up to 64 windows");
    for (const id of p.ids) window(ctx, id);
  },
  "magic.run": (p, ctx) => {
    magicWidget(ctx, p.id);
    text(p.prompt);
  },
  "magic.cancel": (p, ctx) => magicWidget(ctx, p.id),
  "magic.refresh": (p, ctx) => magicWidget(ctx, p.id),
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
    case "magic.data":
    case "magic.stream":
      return follows.has(e.id);
    case "fs.changed":
      return watches.some((w) => e.path === w || e.path.startsWith(w.endsWith("/") ? w : w + "/"));
    case "pane.updated":
    case "pane.removed":
    case "agent.updated":
    case "agent.removed":
    case "window.updated": // TODO: strip the state of types the web client doesn't show (browser history)
    case "window.removed":
    case "workspace.updated":
    case "workspace.removed":
    case "notification":
    case "pane.resync":
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
    case "actions.changed":
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

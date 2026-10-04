// What a paired device may do (docs/13-remote-access.md, "Scopes and the policy
// table"). Fail-closed: every RPC method has an explicit entry (tsc refuses a new
// method until someone decides), anything not allowed is denied, and arguments
// are checked too: panes, agents and windows must belong to an open Space, paths
// must resolve (symlinks followed) inside an open Space's root and off the
// deny-list of private files. Events go through an allowlist as well.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CoreEvent, Method, Params, RemoteScope } from "@cmd/protocol";
import { DEFAULT_DENY_PATHS, isDeniedPath } from "../magic/policy.ts";
import type { AgentTracker } from "../agents/tracker.ts";
import type { PaneManager } from "../panes.ts";
import type { SpaceManager } from "../spaces/manager.ts";
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
  "pane.snapshot": "view",
  "pane.reset": "control",
  "pane.read": "view",
  "agent.list": "view",
  "agent.spawn": "control",
  "agent.send": "control",
  "agent.wait": "never",
  "agent.kill": "control",
  "agent.markSeen": "view",
  "hook.ingest": "never",
  identify: "never",
  "settings.get": "never",
  "settings.set": "never",
  "settings.reset": "never",
  "secrets.status": "never",
  "secrets.set": "never",
  "window.open": "control",
  "window.update": "control",
  "window.types": "view",
  "window.close": "control",
  "window.openTarget": "never",
  "window.move": "never",
  "window.list": "view",
  "window.follow": "view",
  "space.list": "view",
  "space.open": "never",
  "space.match": "never",
  "space.update": "never", // a phone's layout is its own, never Space.view
  "space.close": "never",
  "space.forget": "never",
  "magic.run": "control", // spends API keys, runs the exploring agent
  "magic.cancel": "control",
  "magic.refresh": "view", // re-runs an already approved, read-only source
  "magic.setRefresh": "never",
  "magic.models": "never",
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
  "magic.previewer": "never",
  "magic.previewResult": "never",
  "fs.list": "view",
  "fs.resolve": "never", // an existence oracle for any path; the web client resolves terminal links within Spaces later
  "fs.read": "view",
  "fs.watch": "view",
  "fs.unwatch": "view",
  "fs.write": "control",
  "fs.rename": "control",
  "fs.duplicate": "control",
  "fs.create": "control",
  "git.status": "view",
  "search.query": "never",
  "search.recent": "never",
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
  "remote.revoke": "never",
  "remote.setScope": "never",
  "remote.bootstrap": "view",
};

export class RemoteDenied extends Error {}

export interface PolicyContext {
  panes: PaneManager;
  agents: AgentTracker;
  spaces: SpaceManager;
  windows: WindowManager;
  home?: string;
}

/** Writes and messages from a phone. */
export const MAX_WRITE = 64 * 1024;

type Check<M extends Method> = (p: Params<M>, ctx: PolicyContext) => void;
const ARGS: { [M in Method]?: Check<M> } = {
  "pane.create": (p, ctx) => {
    if (p.spaceId) openSpace(ctx, p.spaceId);
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
    if (p.spaceId) openSpace(ctx, p.spaceId);
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
  "agent.markSeen": (p, ctx) => agent(ctx, p.agentId),
  "window.open": (p, ctx) => {
    if (p.spaceId) openSpace(ctx, p.spaceId);
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
    magicWindow(ctx, p.id);
    text(p.prompt);
  },
  "magic.cancel": (p, ctx) => magicWindow(ctx, p.id),
  "magic.refresh": (p, ctx) => magicWindow(ctx, p.id),
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
  "git.status": (p, ctx) => allowedPath(ctx, p.path),
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

function openSpace(ctx: PolicyContext, id: unknown): void {
  const s = typeof id === "string" ? ctx.spaces.get(id) : undefined;
  if (!s || s.closedAt !== null) throw new RemoteDenied("no such Space");
}

function pane(ctx: PolicyContext, id: unknown): void {
  const p = typeof id === "string" ? ctx.panes.get(id) : null;
  if (!p) throw new RemoteDenied("no such terminal");
  openSpace(ctx, p.spaceId);
}

function agent(ctx: PolicyContext, id: unknown): void {
  const a = typeof id === "string" ? ctx.agents.get(id) : null;
  if (!a) throw new RemoteDenied("no such agent");
  openSpace(ctx, a.spaceId);
}

function window(ctx: PolicyContext, id: unknown): void {
  const w = typeof id === "string" ? ctx.windows.list().find((x) => x.id === id) : undefined;
  if (!w) throw new RemoteDenied("no such window");
  openSpace(ctx, w.spaceId);
}

function magicWindow(ctx: PolicyContext, id: unknown): void {
  window(ctx, id);
  if (ctx.windows.list().find((x) => x.id === id)?.kind !== "magic") throw new RemoteDenied("not a Magic window");
}

/**
 * The real path (symlinks resolved; for a file that doesn't exist yet, its
 * folder's) must be inside an open Space's root and not a private file.
 */
export function allowedPath(ctx: PolicyContext, p: unknown): string {
  if (typeof p !== "string" || !p || p.includes("\0")) throw new RemoteDenied("bad path");
  if (!path.isAbsolute(p) && p !== "~" && !p.startsWith("~/")) throw new RemoteDenied("paths must be absolute");
  const home = ctx.home ?? os.homedir();
  const abs = path.resolve(p.startsWith("~") ? path.join(home, p.slice(1)) : p);
  const real = realpath(abs);
  const roots = ctx.spaces.list().map((s) => realpath(s.root));
  if (!roots.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) throw new RemoteDenied("outside your Spaces");
  if (isDeniedPath(real, DEFAULT_DENY_PATHS, realpath(home)) || isDeniedPath(abs, DEFAULT_DENY_PATHS, home)) throw new RemoteDenied("a private file");
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
    case "space.updated":
    case "space.removed":
    case "notification":
    case "pane.resync":
      return true;
    case "settings.updated":
    case "secrets.updated":
    case "search.status":
    case "space.show":
    case "window.focus":
    case "remote.updated":
    case "remote.pairRequest":
    case "remote.pairEnded":
    case "remote.input":
    case "magic.previewRequest": // sent to the app's previewer only, never broadcast
      return false;
    default: {
      const never: never = e;
      return !!never && false;
    }
  }
}

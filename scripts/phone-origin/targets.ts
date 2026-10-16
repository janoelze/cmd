// The cores the phone origin reaches (docs/56-phone-development.md): "release",
// the installed app, and "dev", the phone's own dev core: one fixed state dir,
// ~/.cmd-phone/home, whichever checkout's code `pnpm phone:core` runs in it, so
// its host key, routes and paired devices stay put and the phone pairs once.
// `pnpm phone:use` can point /c/dev at another CMD_HOME for a while (a
// worktree's own .cmd-dev); the choice lives in a small state file, read again
// on every connection, so switching never restarts Vite. Socket paths and ports
// come from the protocol's and the core's own functions; a core's public origin
// from remote.status.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultDirectPort } from "../../packages/core/src/remote/direct.ts";
import type { RemoteStatus } from "../../packages/protocol/src/index.ts";
import { connect, coreSocketPathOf, type Connection } from "../../packages/protocol/src/node.ts";

export type TargetName = "release" | "dev";
export const TARGETS: readonly TargetName[] = ["release", "dev"];

/** Where a target's core is: its instance, and its CMD_HOME when it has one. */
export interface Target {
  name: TargetName;
  instance: "release" | "dev";
  home: string | null;
  socket: string;
  /** The listener's port when remote.port is 0 (direct.ts). */
  port: number;
}

/** What the target's core says: where its listener is and the origin its upgrades must carry. */
export interface CoreInfo {
  port: number;
  /** The listener's public origin (remote.status address); null while remote access isn't ready. */
  origin: string | null;
  /** Why there's no origin, for the log. */
  error: string | null;
}

/** ~/.cmd-phone, or $CMD_PHONE_DIR (tests). */
export const stateDir = (): string => process.env.CMD_PHONE_DIR || path.join(os.homedir(), ".cmd-phone");
export const targetFile = (): string => path.join(stateDir(), "target.json");
/** The phone's dev core's state dir. */
export const phoneHome = (): string => path.join(stateDir(), "home");

/**
 * The CMD_HOME a `phone:use` argument names: "phone" is the phone's own dev
 * core, a linked worktree its .cmd-dev, anything else a CMD_HOME itself. The
 * main checkout's dev instance (no CMD_HOME) isn't one of them: null.
 */
export function homeFor(arg: string): string | null {
  if (arg === "phone") return phoneHome();
  const p = path.resolve(arg);
  let git: fs.Stats | null = null;
  try {
    git = fs.statSync(path.join(p, ".git"));
  } catch {}
  if (git?.isFile()) return path.join(p, ".cmd-dev");
  if (git?.isDirectory()) return null;
  return p;
}

/** Saves what /c/dev reaches (null: the phone's dev core); takes effect on the next connection. */
export function useDev(home: string | null): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = `${targetFile()}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ dev: { home } }, null, 2) + "\n");
  fs.renameSync(tmp, targetFile());
}

/** What /c/dev reaches: the state file's CMD_HOME, else the phone's dev core. */
function devHome(): string {
  try {
    const v = JSON.parse(fs.readFileSync(targetFile(), "utf8")) as { dev?: { home?: string | null } };
    return v.dev?.home || phoneHome();
  } catch {
    return phoneHome();
  }
}

/** A dev core in `home` (null: the default dev instance). */
export function devTarget(home: string | null): Target {
  return { name: "dev", instance: "dev", home, socket: coreSocketPathOf("dev", home), port: defaultDirectPort({ instance: "dev", home }) };
}

export function resolveTarget(name: TargetName): Target {
  if (name === "dev") return devTarget(devHome());
  return { name, instance: "release", home: null, socket: coreSocketPathOf("release", null), port: defaultDirectPort({ instance: "release", home: null }) };
}

/** What `status` says about reaching the core through its loopback listener. */
function describe(status: RemoteStatus, port: number): CoreInfo {
  const direct = status.enabled && status.access !== "relay";
  const error = !status.enabled ? "remote access is off" : !direct ? "it connects through the hosted relay, so it has no local listener" : status.address ? null : (status.error ?? "remote access isn't ready");
  return { port, origin: direct ? status.address : null, error };
}

const listenPort = async (conn: Connection, t: Target) => Number((await conn.client.call("settings.get", {})).settings["remote.port"]) || t.port;

/** Asks the target's core where its listener is; throws when the core doesn't answer. */
export async function coreInfo(t: Target): Promise<CoreInfo> {
  const conn = await connect(t.socket, { hello: false });
  try {
    const [port, status] = await Promise.all([listenPort(conn, t), conn.client.call("remote.status", {})]);
    return describe(status, port);
  } finally {
    conn.close();
  }
}

/** One line on the dev core /c/dev reaches: ready, why not, or not running. */
export async function devLine(t: Target): Promise<string> {
  try {
    const info = await coreInfo(t);
    return info.origin ? `ready on 127.0.0.1:${info.port}` : `can't take phones yet: ${info.error} (pnpm phone:core turns it on)`;
  } catch {
    return t.home === phoneHome() ? "not running (pnpm phone:core starts it)" : "not running";
  }
}

/**
 * Makes a dev core reachable through the proxy: with remote access off or on
 * the relay, it's switched to "Your own URL" on its own loopback port, which is
 * all the proxy needs, then waited for. Never the release app's. `changed`:
 * whether its settings were changed.
 */
export async function reachable(t: Target, conn: Connection): Promise<{ info: CoreInfo; changed: boolean }> {
  if (t.name === "release") throw new Error("phone tooling never changes the installed cmd's settings");
  const call = conn.client.call.bind(conn.client);
  const port = await listenPort(conn, t);
  let st = await call("remote.status", {});
  const changed = !st.enabled || st.access === "relay";
  if (changed) {
    await call("settings.set", { key: "remote.access", value: "url" });
    await call("settings.set", { key: "remote.url", value: `http://127.0.0.1:${port}` });
    await call("settings.set", { key: "remote.enabled", value: true });
  }
  const end = Date.now() + 10_000;
  while ((st = await call("remote.status", {})).state !== "online" && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  return { info: describe(st, port), changed };
}

/** The `/c/<target>/rest` of a request path, or null when it isn't one. */
export function splitPath(url: string): { target: TargetName; rest: string } | null {
  const m = /^\/c\/(release|dev)(\/.*)?$/.exec(url);
  if (!m) return null;
  return { target: m[1] as TargetName, rest: m[2] || "/" };
}

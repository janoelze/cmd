// Where the phone driver keeps things: $CMD_HOME/phone (else this checkout's
// .cmd-dev/phone): the browser profiles (the pairing lives in their IndexedDB),
// the Vite port it keeps (the origin holds the pairings), which pairing each core
// had, the scenario cores, its log and state.json, which says that it runs and
// where its control port is.

import fs from "node:fs";
import path from "node:path";
import { worktreeHome } from "../../../packages/protocol/src/instance.ts";
import { phoneHome as phoneCoreHome } from "../../../scripts/phone-origin/targets.ts";
import { root, type BrowserName, type DeviceName } from "./harness.ts";

export const baseHome = (): string => path.resolve(process.env.CMD_HOME || worktreeHome(root) || path.join(root, ".cmd-dev"));
/** The driver's own folder (not phone-origin's ~/.cmd-phone). */
export const driverHome = (): string => path.join(baseHome(), "phone");
export const stateFile = (): string => path.join(driverHome(), "state.json");
export const logFile = (): string => path.join(driverHome(), "phone.log");
export const shotsDir = path.join(root, ".cmd-dev", "shots");

export interface PhoneState {
  pid: number;
  /** The control server on loopback. */
  control: number;
  ready: boolean;
  web: string;
  /** Where the client dials: /c/dev on Vite (the phone origin's proxy). */
  socket: string;
  core: { kind: "scenario" | "dev"; name?: string; home: string | null };
  browser: BrowserName;
  device: DeviceName;
  /** How this start came to be paired: it already was, or it paired now. */
  pairing: "kept" | "new";
  deviceId: string;
}

export function readState(): PhoneState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as PhoneState;
  } catch {
    return null;
  }
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The Vite port kept across starts, so the origin (and so the pairing) stays the same. */
export interface Ports {
  web: number;
}
const portsFile = () => path.join(driverHome(), "ports.json");
export function readPorts(): Ports | null {
  try {
    return JSON.parse(fs.readFileSync(portsFile(), "utf8")) as Ports;
  } catch {
    return null;
  }
}
export const writePorts = (p: Ports): void => fs.writeFileSync(portsFile(), JSON.stringify(p));

/**
 * The host key each core was last paired under (scenario:<name>, dev:<home>).
 * When one changes (a scenario's folder was deleted, so its core made a new
 * host key), returns the old key, whose pairing in the profile is dead: the
 * profile then holds one pairing per core, however often it restarts. The same
 * for the device each browser paired as with a core (devices.json): when it
 * paired again, the old device is revoked.
 */
export function forgetReplaced(label: string, key: string, file = path.join(driverHome(), "pairings.json")): string | null {
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {}
  const old = map[label];
  map[label] = key;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
  return old && old !== key ? old : null;
}

/**
 * --core dev's core: this worktree's own ($CMD_HOME, else its .cmd-dev). Not the
 * phone's dev core (phone:core's, ~/.cmd-phone/home: the developer's, and agents'
 * sandboxes can't write there), nor the main checkout's dev instance (the
 * developer's own): those throw, saying what to do.
 */
export function devCoreHome(): string {
  const home = process.env.CMD_HOME || worktreeHome(root);
  if (!home) throw new Error("--core dev uses a worktree's own core, and this is the main checkout. Run it from a worktree, or set CMD_HOME to a folder of its own.");
  if (path.resolve(home) === path.resolve(phoneCoreHome()))
    throw new Error("CMD_HOME is your phone's dev core (pnpm phone:core), which the phone driver leaves alone. Set CMD_HOME to this worktree's .cmd-dev instead.");
  return home;
}

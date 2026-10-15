// Where the phone driver keeps things: $CMD_HOME/phone (else this checkout's
// .cmd-dev/phone): the browser profiles (the pairing lives in their IndexedDB),
// the ports it keeps (the web client's origin and the relay's address are part
// of a pairing), the relay's routes, the scenario cores, its log and state.json,
// which says that it runs and where its control port is.

import fs from "node:fs";
import path from "node:path";
import { worktreeHome } from "../../../packages/protocol/src/instance.ts";
import { root, type BrowserName, type DeviceName } from "./harness.ts";

export const baseHome = (): string => path.resolve(process.env.CMD_HOME || worktreeHome(root) || path.join(root, ".cmd-dev"));
export const phoneHome = (): string => path.join(baseHome(), "phone");
export const stateFile = (): string => path.join(phoneHome(), "state.json");
export const logFile = (): string => path.join(phoneHome(), "phone.log");
export const shotsDir = path.join(root, ".cmd-dev", "shots");

export interface PhoneState {
  pid: number;
  /** The control server on loopback. */
  control: number;
  ready: boolean;
  web: string;
  relay: string;
  core: { kind: "scenario" | "dev"; name?: string; home: string };
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

/** The ports kept across starts, so the origin (and so the pairing) stays the same. */
export interface Ports {
  web: number;
  relay: number;
}
const portsFile = () => path.join(phoneHome(), "ports.json");
export function readPorts(): Ports | null {
  try {
    return JSON.parse(fs.readFileSync(portsFile(), "utf8")) as Ports;
  } catch {
    return null;
  }
}
export const writePorts = (p: Ports): void => fs.writeFileSync(portsFile(), JSON.stringify(p));

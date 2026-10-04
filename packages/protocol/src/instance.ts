// Which cmd instance a process belongs to, and where that instance keeps things.
//
// Two kinds of environment variable, kept apart on purpose:
// - Instance (who am I): $CMD_INSTANCE (release | dev, the build flavor) and
//   $CMD_HOME (put everything of this instance in one folder). The app and the
//   core resolve their state dir, socket and logs from these only.
// - Pane context (whom do I talk to): $CMD_SOCKET, $CMD_PANE_ID… set in every
//   pane for the CLI and hooks. An app or core started from a pane must not pick
//   them up, or a dev build run in the installed app's terminal attaches to (and
//   restarts) the installed app's core. enterInstance() drops them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENV } from "./rpc.ts";

export type InstanceName = "release" | "dev";

/** $CMD_INSTANCE: "dev" for development builds (pnpm dev, "cmd dev"), else release. */
export function instanceName(): InstanceName {
  return process.env.CMD_INSTANCE === "dev" ? "dev" : "release";
}

/** "cmd" or "cmd-dev": the folder name the instance uses next to the other one. */
export const instanceDir = (): string => (instanceName() === "dev" ? "cmd-dev" : "cmd");

/** Pane context set by a core in its shells (see panes.ts, shells.ts and shell/); a test keeps this complete. */
export const PANE_ENV: readonly string[] = [
  ENV.socket,
  ENV.paneId,
  ENV.agentId,
  ENV.parentId,
  "CMD_PANE_TOKEN",
  "CMD_USER_ZDOTDIR",
  "CMD_BASH_INJECT",
  "CMD_USER_ENV",
  "CMD_BASH_UNEXPORT_HISTFILE",
  "CMD_FISH_INJECT",
  "CMD_USER_XDG_DATA_DIRS",
  "CMD_OPEN_RULES",
  "CMD_OPEN_FOLDERS",
  "CMD_OPEN_URLS",
  "CMD_OPEN_FILES",
  "CMD_OPEN_EXTS",
  "CMD_OPEN_HANDLES_FOLDERS",
  "CMD_OPEN_HANDLES_TEXT",
  "CMD_RESTORE_COMMAND",
  "CMD_PANE_HISTFILE",
  "GHOSTTY_AGENTS_SURFACE_ID",
];

/**
 * For processes that are an instance (Electron main, the core): drop the pane
 * context they may have inherited and settle on `name`.
 */
export function enterInstance(name: InstanceName): void {
  for (const k of PANE_ENV) delete process.env[k];
  process.env.CMD_INSTANCE = name;
}

/** State dir: $CMD_HOME, else ~/Library/Application Support/cmd (or cmd-dev). */
export function cmdHome(): string {
  if (process.env.CMD_HOME) return process.env.CMD_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), instanceDir());
  return path.join(os.homedir(), "Library", "Application Support", instanceDir());
}

/**
 * The file holding this install's machine id (see machineId in log.ts):
 * $CMD_HOME/machine-id, else machine-id in the release instance's state dir,
 * so release and dev builds on one Mac report the same id.
 */
export function machineIdPath(): string {
  if (process.env.CMD_HOME) return path.join(process.env.CMD_HOME, "machine-id");
  return path.join(path.dirname(cmdHome()), "cmd", "machine-id");
}

/** $CMD_CONFIG_DIR, else $CMD_HOME (isolated runs), else ~/.config/cmd, shared by release and dev. */
export function configDir(): string {
  return process.env.CMD_CONFIG_DIR ?? process.env.CMD_HOME ?? path.join(os.homedir(), ".config", "cmd");
}

/**
 * The socket this instance's core listens on: $CMD_HOME/core.sock, else the
 * per-user temp dir (cmd or cmd-dev). The temp dir (/var/folders/…) stays
 * reachable from sandboxed agents, unlike ~/Library. Never $CMD_SOCKET.
 */
export function coreSocketPath(): string {
  if (process.env.CMD_HOME) return path.join(process.env.CMD_HOME, "core.sock");
  return path.join(os.tmpdir(), instanceDir(), "core.sock");
}

/** The PTY host's socket, next to the core's (see packages/core/src/terminals/host.ts). */
export function ptyHostSocketPath(): string {
  return path.join(path.dirname(coreSocketPath()), "ptyhost.sock");
}

/**
 * Whether a core that answered core.hello belongs to the instance at `home`.
 * Only its own instance may stop a core. Cores from before core.hello reported
 * stateDir are recognised by the instance's pid file.
 */
export function isOwnCore(hello: { pid: number; stateDir?: string }, home = cmdHome()): boolean {
  if (hello.stateDir) return path.resolve(hello.stateDir) === path.resolve(home);
  try {
    return Number(fs.readFileSync(path.join(home, "core.pid"), "utf8")) === hello.pid;
  } catch {
    return false;
  }
}

/** Where a client connects: $CMD_SOCKET (the pane's own core), else this instance's core. */
export function defaultSocketPath(): string {
  return process.env[ENV.socket] || coreSocketPath();
}

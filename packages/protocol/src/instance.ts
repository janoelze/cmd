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
  "CMD_OPEN_PACKAGES",
  "CMD_RESTORE_COMMAND",
  "CMD_PANE_HISTFILE",
];

/**
 * For processes that are an instance (Electron main, the core): drop the pane
 * context they may have inherited and settle on `name`. `checkout`: the repo a
 * development build runs from, for worktreeHome().
 */
export function enterInstance(name: InstanceName, checkout?: string): void {
  for (const k of PANE_ENV) delete process.env[k];
  process.env.CMD_INSTANCE = name;
  const own = name === "dev" && !process.env.CMD_HOME && checkout ? worktreeHome(checkout) : null;
  if (own) process.env.CMD_HOME = own;
}

/**
 * The state dir of a development build run from a linked git worktree:
 * <worktree>/.cmd-dev, so it is its own instance (core, PTY host, socket,
 * state) unless $CMD_HOME says otherwise. Worktrees sharing the dev instance
 * restarted each other's cores and left a core or PTY host running from a
 * worktree that was then removed. Null in the main checkout, which keeps the
 * dev instance, and outside a checkout (packaged builds).
 */
export function worktreeHome(checkout: string): string | null {
  try {
    // .git is a file ("gitdir: …") only in a linked worktree; a folder can't be read as one.
    return fs.readFileSync(path.join(checkout, ".git"), "utf8").startsWith("gitdir:") ? path.join(checkout, ".cmd-dev") : null;
  } catch {
    return null;
  }
}

/** State dir: $CMD_HOME, else ~/Library/Application Support/cmd (or cmd-dev). */
export function cmdHome(): string {
  return process.env.CMD_HOME || defaultHome(instanceName());
}

/** The state dir `name` has when $CMD_HOME doesn't say: ~/Library/Application Support/cmd or cmd-dev. */
export function defaultHome(name: InstanceName, homedir = os.homedir()): string {
  const dir = name === "dev" ? "cmd-dev" : "cmd";
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(homedir, "AppData", "Local"), dir);
  return path.join(homedir, "Library", "Application Support", dir);
}

/**
 * The other instance when `home` is its default state dir, else null. A core
 * runs only on a state dir of its own instance: a dev build on the installed
 * app's data would migrate it to a schema the installed cmd can't write (and
 * the reverse). Any other $CMD_HOME (tests, e2e, worktrees) is anyone's.
 */
export function foreignHome(home: string, name: InstanceName = instanceName(), homedir = os.homedir()): InstanceName | null {
  const other: InstanceName = name === "dev" ? "release" : "dev";
  return samePath(home, defaultHome(other, homedir)) ? other : null;
}

/** Two paths name one folder (symlinks resolved where they exist; case as the disk has it). */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
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

/**
 * A core that won't start on its state dir (core/data/state-dir.ts: another
 * instance's, or data from a newer cmd) exits with CORE_REFUSED_EXIT after
 * printing one line, `cmd core: refused (<reason>): <text for people>`, which
 * the app shows instead of its generic "couldn't start" (coreRefusal).
 */
export const CORE_REFUSED_EXIT = 78;
export type CoreRefusalReason = "too-new" | "foreign";
export const coreRefusalLine = (reason: CoreRefusalReason, text: string): string => `cmd core: refused (${reason}): ${text}`;

/** The refusal in a core's output, the last one if several; null without one. */
export function coreRefusal(lines: readonly string[]): { reason: CoreRefusalReason; text: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^cmd core: refused \((too-new|foreign)\): (.+)$/.exec(lines[i]!.trim());
    if (m) return { reason: m[1] as CoreRefusalReason, text: m[2]! };
  }
  return null;
}

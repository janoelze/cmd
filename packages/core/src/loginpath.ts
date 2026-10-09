// The user's PATH for everything the core runs. An app started from the Dock
// gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), so widgets, magic
// commands and git lookups couldn't find Homebrew's gh, glab, docker, etc.
// Terminals are unaffected (they start login shells), so this asks the user's
// login shell once, the way terminals see it, and merges that into
// process.env.PATH. Children spawned later inherit it.

import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import { logger } from "@cmd/protocol/node";

const log = logger("path");

const MARK = "__CMD_LOGIN_PATH__";
/** Where macOS tools usually live; added if they exist, in case the shell can't be asked. */
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];

/**
 * PATH as an interactive login shell sets it, or null (no answer within
 * `timeoutMs`, or the shell failed). Interactive too, since many people set
 * PATH in .zshrc/.bashrc. `printenv` makes the output the same for any shell.
 */
export function loginShellPath(shell: string, o: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shell, ["-l", "-i", "-c", `echo ${MARK}; /usr/bin/printenv PATH; echo ${MARK}`], {
        env: { ...(o.env ?? process.env), CMD_RESOLVING_ENVIRONMENT: "1" },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true, // own process group, so a timeout also kills what the rc files started
      });
    } catch {
      return resolve(null);
    }
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), o.timeoutMs ?? 10_000);
    child.stdout!.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      const m = out.match(new RegExp(`${MARK}\\r?\\n([^\\r\\n]*)\\r?\\n${MARK}`));
      if (m) finish(m[1]!.trim() || null);
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
  });
}

/**
 * The login shell's entries, then the current ones not already in it, then
 * existing fallback dirs; no duplicates or empties. A current PATH that has all
 * of the login one (a core started from a terminal) keeps its order, so e.g. an
 * active virtualenv still comes first.
 */
export function mergePath(login: string | null, current: string, exists: (dir: string) => boolean = fs.existsSync): string {
  const loginDirs = (login ?? "").split(":").filter(Boolean);
  const currentDirs = current.split(":").filter(Boolean);
  const order = loginDirs.every((d) => currentDirs.includes(d)) ? [currentDirs] : [loginDirs, currentDirs];
  const out: string[] = [];
  for (const dirs of order) for (const d of dirs) if (!out.includes(d)) out.push(d);
  for (const d of FALLBACK_DIRS) if (!out.includes(d) && exists(d)) out.push(d);
  return out.join(":");
}

/** Settles once adoptLoginPath has finished; what spawns user tools waits for it. */
export let pathReady: Promise<void> = Promise.resolve();

/** Merge the login shell's PATH into process.env.PATH (once, at startup). Never throws. */
export function adoptLoginPath(shell = process.env.SHELL || "/bin/zsh"): Promise<void> {
  if (process.platform === "win32") return pathReady;
  return (pathReady = adopt(shell));
}

async function adopt(shell: string): Promise<void> {
  const start = Date.now();
  const login = await loginShellPath(shell);
  const before = process.env.PATH ?? "";
  process.env.PATH = mergePath(login, before);
  if (login === null) log.warn(`couldn't read PATH from ${shell}; using ${process.env.PATH}`);
  else if (process.env.PATH !== before) log.info(`PATH from ${shell} (${Date.now() - start} ms): ${process.env.PATH}`);
}

export interface ExecResult {
  /** Exit code; null when it was killed (timeout) or couldn't start. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it didn't run to completion: "ENOENT", "timeout"…; null when it exited. */
  error: string | null;
}

/** Run a tool on the login PATH and collect its output. Never throws; `error` says what went wrong. */
export async function exec(cmd: string, args: string[], o: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  await pathReady;
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: o.timeout ?? 10_000, env: o.env ? { ...process.env, ...o.env } : process.env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      const code = !e ? 0 : typeof e.code === "number" ? e.code : null;
      const error = !e || typeof e.code === "number" ? null : e.killed ? "timeout" : String(e.code ?? e.message);
      resolve({ code, stdout: String(stdout), stderr: String(stderr), error });
    });
  });
}

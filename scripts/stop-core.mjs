// Stops cmd cores. Cores are detached and outlive the app on purpose, so dev and
// test runs leave them behind. Their terminals run in a PTY host that outlives
// the core too (packages/core/src/terminals/host.ts): stopping a core keeps them,
// --terminals stops its host as well. The installed app's core is only stopped
// when asked for, so this is safe to run in its terminals.
//   node scripts/stop-core.mjs                        the core of $CMD_HOME, else the dev instance's (a worktree's own)
//   node scripts/stop-core.mjs --terminals            … and its PTY host (its terminals close)
//   node scripts/stop-core.mjs --release              the installed app's core
//   node scripts/stop-core.mjs --all                  every dev and test core and PTY host on this machine
//   node scripts/stop-core.mjs --all --include-release  … and the installed app's
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cmdHome, enterInstance } from "../packages/protocol/src/node.ts";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

/** SIGTERM (the core shuts down cleanly), then SIGKILL after `graceMs`. */
export async function stopPid(pid, graceMs = 3000) {
  if (!alive(pid)) return false;
  process.kill(pid, "SIGTERM");
  for (let t = 0; t < graceMs && alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) process.kill(pid, "SIGKILL");
  return true;
}

/** The pid in `<home>/<name>.pid` (core, ptyhost), if any. */
export function corePid(home = cmdHome(), name = "core") {
  try {
    const pid = Number(fs.readFileSync(path.join(home, `${name}.pid`), "utf8"));
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const isCore = (cmdline) => /packages\/core\/src\/(main|terminals\/host-main)\.ts/.test(cmdline.replaceAll("\\", "/"));

/**
 * The installed app's core: started with --instance=release, or, by cores from
 * before that flag, run from the release state dir's runtime copy.
 */
const isReleaseCore = (cmdline) => {
  const c = cmdline.replaceAll("\\", "/");
  return c.includes("--instance=release") || (!c.includes("--instance=") && /\/cmd\/runtime\//.test(c));
};

/** A pid file left by a crash may name a reused pid: check it is a core where we can. */
function looksLikeCore(pid) {
  if (process.platform === "win32") return true;
  try {
    return isCore(execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return alive(pid); // no ps (sandboxed) or no such process
  }
}

/** Stops the core whose state dir is `home` (with `terminals`, its PTY host too); true if one was running. */
export async function stopCore(home = cmdHome(), { terminals = false } = {}) {
  const pid = corePid(home);
  const stopped = pid && looksLikeCore(pid) ? await stopPid(pid) : false;
  const host = terminals ? corePid(home, "ptyhost") : null;
  return (host && looksLikeCore(host) ? await stopPid(host) : false) || stopped;
}

/** Pids of running cmd cores and PTY hosts: dev (any checkout), tests, and with `release` the installed app's. */
function allCores(release) {
  const lines =
    process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"], { encoding: "utf8" })
      : execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return lines
    .split(/\r?\n/)
    .filter((l) => isCore(l) && (release || !isReleaseCore(l)))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

if (path.resolve(process.argv[1] ?? "") === import.meta.filename) {
  const args = process.argv.slice(2);
  // $CMD_INSTANCE may be inherited from a pane; the flags decide. In a linked
  // worktree the dev instance is the worktree's own (instance.ts, worktreeHome).
  enterInstance(args.includes("--release") ? "release" : "dev", path.resolve(import.meta.dirname, ".."));
  if (args.includes("--all")) {
    const pids = allCores(args.includes("--include-release")).filter((p) => p !== process.pid);
    for (const pid of pids) await stopPid(pid);
    console.log(pids.length ? `stopped ${pids.length} core${pids.length === 1 ? "" : "s"} and PTY host${pids.length === 1 ? "" : "s"}: ${pids.join(", ")}` : "no cores running");
  } else {
    const home = cmdHome();
    const terminals = args.includes("--terminals");
    const what = terminals ? "the core and terminals" : "the core (its terminals keep running; --terminals stops them)";
    console.log((await stopCore(home, { terminals })) ? `stopped ${what} of ${home}` : `no core running for ${home}`);
  }
}

// Stops cmd cores. Cores are detached and outlive the app on purpose, so dev and
// test runs leave them behind (each holding its terminals' PTYs).
//   node scripts/stop-core.mjs        the core of $CMD_HOME (or the default state dir)
//   node scripts/stop-core.mjs --all  every cmd core on this machine, the real one included
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cmdHome } from "../packages/protocol/src/node.ts";

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

/** The pid in `<home>/core.pid`, if any. */
export function corePid(home = cmdHome()) {
  try {
    const pid = Number(fs.readFileSync(path.join(home, "core.pid"), "utf8"));
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const isCore = (cmdline) => cmdline.replaceAll("\\", "/").includes("packages/core/src/main.ts");

/** A pid file left by a crash may name a reused pid: check it is a core where we can. */
function looksLikeCore(pid) {
  if (process.platform === "win32") return true;
  try {
    return isCore(execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return alive(pid); // no ps (sandboxed) or no such process
  }
}

/** Stops the core whose state dir is `home`; true if one was running. */
export async function stopCore(home = cmdHome()) {
  const pid = corePid(home);
  return pid && looksLikeCore(pid) ? stopPid(pid) : false;
}

/** Pids of every running cmd core: dev (any checkout), tests, the packaged app. */
function allCores() {
  const lines =
    process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"], { encoding: "utf8" })
      : execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return lines
    .split(/\r?\n/)
    .filter(isCore)
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

if (path.resolve(process.argv[1] ?? "") === import.meta.filename) {
  if (process.argv.includes("--all")) {
    const pids = allCores().filter((p) => p !== process.pid);
    for (const pid of pids) await stopPid(pid);
    console.log(pids.length ? `stopped ${pids.length} core${pids.length === 1 ? "" : "s"}: ${pids.join(", ")}` : "no cores running");
  } else {
    const home = cmdHome();
    console.log((await stopCore(home)) ? `stopped the core of ${home}` : `no core running for ${home}`);
  }
}

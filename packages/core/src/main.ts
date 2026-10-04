// Entry point: `node packages/core/src/main.ts [--instance=dev|release]` (or
// `pnpm core`, which runs the dev instance). The instance comes from the flag,
// else $CMD_INSTANCE; $CMD_HOME relocates it (see protocol/instance.ts).

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { cmdHome, configDir, coreSocketPath, enterInstance, initLog, instanceName, installCrashHandlers, ipcPath, logDir, logger, ptyHostSocketPath, sourceBuildId } from "@cmd/protocol/node";
import { Core } from "./core.ts";
import { USAGE_URL } from "./usage.ts";
import { nodePtyFactory } from "./panes.ts";
import { adoptLoginPath } from "./loginpath.ts";
import { ProcInfo } from "./agents/procinfo.ts";
import { statusRoot } from "./agents/statusfiles.ts";
import { locateContext } from "./search/sources.ts";
import { SearchService } from "./search/service.ts";
import { connectHost } from "./terminals/remote.ts";
import type { TermBackend } from "./terminals/types.ts";

// The packaged app runs the core as `Electron` with ELECTRON_RUN_AS_NODE; don't
// pass that on to shells, or every Electron app started from a pane runs as Node.
delete process.env.ELECTRON_RUN_AS_NODE;

// Started from a pane, the core must not take over that pane's core socket or
// hand its agent ids on to its own shells.
const flag = process.argv.find((a) => a.startsWith("--instance="))?.slice("--instance=".length);
enterInstance(flag === "dev" || (!flag && process.env.CMD_INSTANCE === "dev") ? "dev" : "release");

// Logs to logDir()/core.log; stdout and stderr (where the app points them) only
// get what bypasses the logger, e.g. Node's own fatal errors.
initLog("core", { level: instanceName() === "dev" ? "debug" : "info" });
const log = logger("core");
const build = sourceBuildId(path.resolve(import.meta.dirname, "../../.."));
installCrashHandlers("core", { exitOnException: true, context: () => ({ build }) });

const procinfo = new ProcInfo();
if (!procinfo.available) log.warn("native/build/procinfo missing (run pnpm install); agent detection falls back to process names");

const home = cmdHome();
fs.mkdirSync(home, { recursive: true });
const socketPath = coreSocketPath();

// A second core must not get as far as taking the PTY host over from the first.
if (await answers(socketPath)) {
  log.error(`a core is already running on ${socketPath}`);
  console.error(`cmd core: a core is already running on ${socketPath}`);
  process.exit(1);
}

// The user's PATH, in the background: launch isn't held up, and commands the core runs wait for it.
void adoptLoginPath();

// Terminals run in the PTY host, so they outlive this process; if it can't be
// started they run here and die with the core (restore.ts brings them back).
const host = () => connectHost({ socketPath: ptyHostSocketPath(), instance: instanceName(), outputFile: path.join(logDir(), "ptyhost.out.log") });
let terminals: TermBackend | Awaited<ReturnType<typeof nodePtyFactory>>;
try {
  terminals = await host();
} catch (err) {
  log.error(`no PTY host, terminals run in the core: ${(err as Error).message}`);
  terminals = await nodePtyFactory();
}

const core = new Core({
  search: (s, sources) => {
    if (!s["search.enabled"]) return null;
    const archives = s["search.archiveDirs"].split(",").map((d) => d.trim()).filter(Boolean);
    return new SearchService(path.join(home, "search.sqlite"), sources.locate(locateContext(), archives));
  },
  socketPath,
  dbPath: path.join(home, "cmd.sqlite"),
  settingsPath: path.join(configDir(), "settings.json"),
  secretsPath: path.join(home, "secrets.json"),
  shellRulesFile: path.join(home, "shell-open.zsh"),
  terminals,
  reconnectTerminals: host,
  // Only a core whose socket nobody reaches gets replaced (a second core starts
  // only when the first doesn't answer): it has nothing left to serve.
  onReplaced: () => process.kill(process.pid, "SIGTERM"),
  inspector: procinfo.available ? (pid) => procinfo.query(pid) : null,
  sampler: procinfo.available ? (pids) => procinfo.trees(pids) : null,
  procSampler: procinfo.available ? (pids) => procinfo.procs(pids) : null,
  statusRoot: statusRoot(),
  build,
  stateDir: home,
  // Release builds started by the app; anything else only when asked to.
  usageUrl: process.env.CMD_USAGE_URL || (instanceName() === "release" && process.env.CMD_APP_VERSION ? USAGE_URL : null),
});

core.restore();
try {
  await core.listen();
} catch (err) {
  log.error(`could not listen: ${(err as Error).message}`);
  console.error(`cmd core: ${(err as Error).message}`);
  process.exit(1);
}
const pidFile = path.join(home, "core.pid");
fs.writeFileSync(pidFile, String(process.pid));
log.info(`pid ${process.pid} listening on ${socketPath}`, { instance: instanceName(), home, version: process.env.CMD_APP_VERSION ?? "source", build, node: process.versions.node, platform: `${process.platform} ${process.arch}` });
console.log(`cmd core ${process.pid} listening on ${socketPath}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  log.info("shutting down");
  await core.close();
  // A core started while we still close (the app waits for our exit, others may not) owns the pid file now: keep it.
  try {
    if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) fs.rmSync(pidFile, { force: true });
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function answers(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(ipcPath(sock));
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
}

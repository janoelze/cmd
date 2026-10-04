// Entry point of the PTY host (host.ts): `node host-main.ts --instance=dev|release`.
// Started detached by the core (remote.ts); exits once no core and no terminals
// are left, or when the core asks it to.

import fs from "node:fs";
import path from "node:path";
import { cmdHome, enterInstance, initLog, installCrashHandlers, instanceName, logger, ptyHostSocketPath } from "@cmd/protocol/node";
import { PtyHost, HOST_PROTOCOL } from "./host.ts";
import { nodePtyFactory } from "./pty.ts";

// Started by a packaged core (Electron as Node): shells must not inherit that.
delete process.env.ELECTRON_RUN_AS_NODE;
const flag = process.argv.find((a) => a.startsWith("--instance="))?.slice("--instance=".length);
enterInstance(flag === "dev" ? "dev" : "release");
initLog("ptyhost", { level: instanceName() === "dev" ? "debug" : "info" });
installCrashHandlers("ptyhost", { exitOnException: true });
const log = logger("ptyhost");

const pidFile = path.join(cmdHome(), "ptyhost.pid");
const exit = (code: number) => {
  try {
    if (Number(fs.readFileSync(pidFile, "utf8")) === process.pid) fs.rmSync(pidFile);
  } catch {}
  process.exit(code);
};

const host = new PtyHost(await nodePtyFactory(), {
  onIdle: () => {
    log.info("no core and no terminals: exiting");
    exit(0);
  },
});
const socketPath = ptyHostSocketPath();
try {
  await host.listen(socketPath);
} catch (err) {
  log.error(`could not listen: ${(err as Error).message}`);
  process.exit(1);
}
fs.mkdirSync(cmdHome(), { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));
// The app keeps this code folder (a packaged runtime copy) while the host runs from it.
fs.writeFileSync(path.join(cmdHome(), "ptyhost.root"), path.resolve(import.meta.dirname, "../../../.."));
log.info(`pid ${process.pid} listening on ${socketPath}`, { protocol: HOST_PROTOCOL, node: process.versions.node });

// Stopped on purpose (scripts/stop-core.mjs, logout): the terminals go with it.
const stop = async () => {
  log.info("stopping");
  await host.close();
  exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

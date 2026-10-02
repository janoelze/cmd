// Entry point: `node packages/core/src/main.ts` (or `pnpm core`).

import fs from "node:fs";
import path from "node:path";
import { cmdHome, configDir, defaultSocketPath, sourceBuildId } from "@cmd/protocol/node";
import { Core } from "./core.ts";
import { nodePtyFactory } from "./panes.ts";
import { ProcInfo } from "./agents/procinfo.ts";
import { statusRoot } from "./agents/statusfiles.ts";

const procinfo = new ProcInfo();
if (!procinfo.available) console.warn("cmd core: native/build/procinfo missing (run pnpm install); agent detection falls back to process names");

const home = cmdHome();
fs.mkdirSync(home, { recursive: true });
const socketPath = defaultSocketPath();

const core = new Core({
  socketPath,
  dbPath: path.join(home, "cmd.sqlite"),
  settingsPath: path.join(configDir(), "settings.json"),
  ptyFactory: await nodePtyFactory(),
  inspector: procinfo.available ? (pid) => procinfo.query(pid) : null,
  sampler: procinfo.available ? (pids) => procinfo.trees(pids) : null,
  statusRoot: statusRoot(),
  build: sourceBuildId(path.resolve(import.meta.dirname, "../../..")),
});

try {
  await core.listen();
} catch (err) {
  console.error(`cmd core: ${(err as Error).message}`);
  process.exit(1);
}
const pidFile = path.join(home, "core.pid");
fs.writeFileSync(pidFile, String(process.pid));
console.log(`cmd core ${process.pid} listening on ${socketPath}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await core.close();
  fs.rmSync(pidFile, { force: true });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

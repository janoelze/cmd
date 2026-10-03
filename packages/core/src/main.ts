// Entry point: `node packages/core/src/main.ts [--instance=dev|release]` (or
// `pnpm core`, which runs the dev instance). The instance comes from the flag,
// else $CMD_INSTANCE; $CMD_HOME relocates it (see protocol/instance.ts).

import fs from "node:fs";
import path from "node:path";
import { cmdHome, configDir, coreSocketPath, enterInstance, sourceBuildId } from "@cmd/protocol/node";
import { Core } from "./core.ts";
import { nodePtyFactory } from "./panes.ts";
import { ProcInfo } from "./agents/procinfo.ts";
import { statusRoot } from "./agents/statusfiles.ts";
import { locateContext } from "./search/sources.ts";
import { SearchService } from "./search/service.ts";

// The packaged app runs the core as `Electron` with ELECTRON_RUN_AS_NODE; don't
// pass that on to shells, or every Electron app started from a pane runs as Node.
delete process.env.ELECTRON_RUN_AS_NODE;

// Started from a pane, the core must not take over that pane's core socket or
// hand its agent ids on to its own shells.
const flag = process.argv.find((a) => a.startsWith("--instance="))?.slice("--instance=".length);
enterInstance(flag === "dev" || (!flag && process.env.CMD_INSTANCE === "dev") ? "dev" : "release");

const procinfo = new ProcInfo();
if (!procinfo.available) console.warn("cmd core: native/build/procinfo missing (run pnpm install); agent detection falls back to process names");

const home = cmdHome();
fs.mkdirSync(home, { recursive: true });
const socketPath = coreSocketPath();

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
  ptyFactory: await nodePtyFactory(),
  inspector: procinfo.available ? (pid) => procinfo.query(pid) : null,
  sampler: procinfo.available ? (pids) => procinfo.trees(pids) : null,
  statusRoot: statusRoot(),
  build: sourceBuildId(path.resolve(import.meta.dirname, "../../..")),
  stateDir: home,
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

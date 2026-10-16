// `pnpm phone:core [checkout]` (default: this one): runs the phone's dev core
// (docs/56-phone-development.md) from that checkout's code. Its state dir is
// always ~/.cmd-phone/home, so its host key, routes and paired devices stay put
// and the phone pairs once, whichever worktree it runs. One runs at a time:
// when it's running another checkout's code it's stopped first, terminals
// included (they belong to the phone home, and a PTY host from a removed
// checkout can't start shells). Then it's made reachable through the proxy
// (remote access on, Your own URL on loopback) and /c/dev points at it.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect, PANE_ENV } from "../../packages/protocol/src/node.ts";
import { devTarget, phoneHome, reachable, useDev } from "./targets.ts";

const here = path.resolve(import.meta.dirname, "../..");
const checkout = fs.realpathSync(path.resolve(process.argv[2] ?? here));
const main = path.join(checkout, "packages/core/src/main.ts");
if (!fs.existsSync(main)) {
  console.error(`${checkout} isn't a cmd checkout.`);
  process.exit(1);
}
const home = phoneHome();
const t = devTarget(home);
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The checkout the running phone core's code is from, or null when none runs. */
async function running(): Promise<string | null> {
  try {
    const conn = await connect(t.socket);
    conn.close();
    return conn.hello?.root ? real(conn.hello.root) : "?";
  } catch {
    return null;
  }
}

const was = await running();
if (was && was !== checkout) {
  // stop-core.mjs, as `pnpm core:stop --terminals` runs it for this CMD_HOME.
  execFileSync(process.execPath, [path.join(here, "scripts/stop-core.mjs"), "--terminals"], { env: { ...process.env, CMD_HOME: home }, stdio: "ignore" });
}
if (was !== checkout) {
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, CMD_HOME: home };
  for (const k of PANE_ENV) delete env[k];
  spawn(process.execPath, ["--no-warnings", main, "--instance=dev"], { cwd: checkout, env, stdio: "ignore", detached: true }).unref();
  const end = Date.now() + 20_000;
  while ((await running()) !== checkout) {
    if (Date.now() > end) {
      console.error(`The phone's dev core didn't start. Its log is in ${path.join(home, "logs")}.`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const conn = await connect(t.socket);
const { info, changed } = await reachable(t, conn);
conn.close();
useDev(null);
console.log(`The phone's dev core ${was === checkout ? "runs" : "now runs"} ${checkout}${was && was !== checkout ? ` (was ${was}; its terminals ended)` : ""}
  /c/dev → ${home}
  ${info.origin ? `ready on 127.0.0.1:${info.port}${changed ? " (turned on its remote access: Your own URL, on loopback)" : ""}` : `can't take phones yet: ${info.error}`}`);
process.exit(info.origin ? 0 : 1);

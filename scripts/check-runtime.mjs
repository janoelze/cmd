// Boots the core staged by stage-runtime.mjs (apps/desktop/.runtime) in a
// throwaway state dir and talks to it, as the packaged app does. CI runs it
// after staging: the e2e test runs the core from source, so a dependency
// missing from the packaged runtime would otherwise ship unnoticed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const main = path.join(root, "apps/desktop/.runtime/packages/core/src/main.ts");
if (!fs.existsSync(main)) {
  console.error("no staged runtime; run node scripts/stage-runtime.mjs first");
  process.exit(1);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-runtime-check-"));
process.env.CMD_HOME = home;
const { connect } = await import("../packages/protocol/src/node.ts");

let log = "";
const core = spawn(process.execPath, ["--no-warnings", main], { env: { ...process.env, CMD_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
core.stdout.on("data", (d) => (log += d));
core.stderr.on("data", (d) => (log += d));
let exited = null;
core.on("exit", (code) => (exited = code));

let ok = false;
try {
  for (let i = 0; i < 60 && exited === null; i++) {
    try {
      const c = await connect();
      const hello = await c.client.call("core.hello", {});
      const types = await c.client.call("window.types", {});
      c.close();
      console.log(`staged core ${hello.version} answers; window types: ${types.map((t) => t.kind).join(", ")}`);
      ok = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
} finally {
  core.kill();
  fs.rmSync(home, { recursive: true, force: true });
}
if (!ok) {
  console.error(`the staged core didn't answer${exited !== null ? ` (it exited ${exited})` : ""}:\n${log.trim().slice(-3000)}`);
  process.exit(1);
}
process.exit(0);

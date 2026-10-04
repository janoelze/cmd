// CPU profile of the app window's startup (docs/14-performance.md): run after
// e2e/startup.mjs has left its state (6 terminals) in .cmd-dev/startup-e2e, with
// the core running. Prints the functions with the most self time until the
// terminals are written.  usage: node e2e/startup-profile.mjs
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const home = path.join(root, ".cmd-dev", "startup-e2e");
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const app = await electron.launch({
  executablePath: require("electron"),
  args: [path.join(root, "apps/desktop")],
  env: { ...process.env, CMD_HOME: home, CMD_NO_SANDBOX: "1", CMD_TRANSCRIPTS_HOME: path.join(home, "transcripts-home") },
});
const win = await app.firstWindow();
const cdp = await win.context().newCDPSession(win);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
await win.waitForFunction(() => performance.getEntriesByName("boot:terminals").length, null, { timeout: 30_000 });
await win.waitForTimeout(300);
const { profile } = await cdp.send("Profiler.stop");
const self = new Map();
const dt = new Map();
for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
let total = 0;
for (const n of profile.nodes) {
  const us = dt.get(n.id) ?? 0;
  total += us;
  const f = n.callFrame;
  if (f.functionName === "(idle)" || f.functionName === "(program)") continue;
  const key = `${f.functionName || "(anon)"} ${(f.url.split("/").pop() || "").split("?")[0]}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + us);
}
// Inclusive time per function (each counted once per stack), to see which callers own the cost.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const incl = new Map();
for (const n of profile.nodes) {
  const us = dt.get(n.id) ?? 0;
  if (!us) continue;
  const seen = new Set();
  for (let id = n.id; id !== undefined; id = parent.get(id)) {
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || "(anon)"} ${(f.url.split("/").pop() || "").split("?")[0]}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    incl.set(key, (incl.get(key) ?? 0) + us);
  }
}
if (process.argv.includes("--inclusive")) {
  for (const [k, us] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(`${(us / 1000).toFixed(1).padStart(7)} ms  ${k}`);
}
const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log(`profiled ${Math.round(total / 1000)} ms`);
for (const [k, us] of top) console.log(`${(us / 1000).toFixed(1).padStart(7)} ms  ${k}`);
const proc = app.process();
const exited = new Promise((r) => proc.once("exit", r));
app.close().catch(() => {});
await exited;
process.exit(0);

// `pnpm phone`: drive the web client (apps/web) in an emulated iPhone, paired with a
// throwaway core seeded from a scenario, or with this checkout's dev core. `start`
// runs daemon.ts in the background and waits until the phone shows Now; the other
// commands go to it over its control port and print what it says. HELP in args.ts.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { HELP, parseArgs, type Parsed } from "./args.ts";
import { sleep, stopCore } from "./harness.ts";
import { alive, logFile, driverHome, readState, stateFile, type PhoneState } from "./state.ts";

let parsed: Parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const { command, args, flags } = parsed;

const running = (): (PhoneState & { notes?: string[] }) | null => {
  const s = readState();
  return s && alive(s.pid) ? s : null;
};
const where = (s: PhoneState) => (s.core.kind === "dev" ? `this worktree's dev core (${s.core.home})` : `scenario ${s.core.name}`);

async function send(command: string, args: string[] = [], flags: Record<string, string | true> = {}): Promise<{ ok: boolean; out: string }> {
  const s = running();
  if (!s) {
    console.error("The phone isn't running. Start it with pnpm phone start.");
    process.exit(1);
  }
  const res = await fetch(`http://127.0.0.1:${s.control}/`, { method: "POST", body: JSON.stringify({ command, args, flags }) });
  return (await res.json()) as { ok: boolean; out: string };
}

async function start() {
  const s = running();
  if (s) {
    console.log(`The phone is already running: ${s.device} in ${s.browser}, paired with ${where(s)}. pnpm phone stop first to start it differently.`);
    return;
  }
  fs.mkdirSync(driverHome(), { recursive: true });
  fs.rmSync(stateFile(), { force: true });
  const from = fs.existsSync(logFile()) ? fs.statSync(logFile()).size : 0;
  const out = fs.openSync(logFile(), "a");
  const child = spawn(process.execPath, ["--no-warnings", path.join(import.meta.dirname, "daemon.ts"), JSON.stringify({ core: flags.core, browser: flags.browser, device: flags.device })], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  let exited = false;
  child.on("exit", () => (exited = true));
  const end = Date.now() + 120_000;
  for (;;) {
    const st = readState();
    if (st?.ready && st.pid === child.pid) break;
    if (exited || Date.now() > end) {
      const tail = fs.readFileSync(logFile(), "utf8").slice(from).trimEnd().split("\n").slice(-15).join("\n");
      console.error(`The phone didn't start${exited ? "" : " within 2 min"}. From ${logFile()}:\n${tail}`);
      if (!exited) process.kill(child.pid!, "SIGTERM");
      process.exit(1);
    }
    await sleep(200);
  }
  const st = running()!;
  for (const n of st.notes ?? []) console.log(n);
  console.log(`Phone: ${st.device} in ${st.browser}, ${st.web}`);
  console.log(`Core: ${where(st)}`);
  console.log(st.pairing === "kept" ? `Paired already: no pairing ran (device ${st.deviceId}).` : `Paired this browser now (device ${st.deviceId}).`);
  const { out: list } = await send("ls");
  console.log(`Terminals:\n${list.replace(/^/gm, "  ")}`);
  console.log(`Log: ${logFile()}`);
}

async function stop() {
  const s = readState();
  if (!s || !alive(s.pid)) {
    fs.rmSync(stateFile(), { force: true });
    console.log("The phone isn't running.");
    return;
  }
  process.kill(s.pid, "SIGTERM");
  for (let t = 0; t < 15_000 && alive(s.pid); t += 200) await sleep(200);
  if (alive(s.pid)) {
    process.kill(s.pid, "SIGKILL");
    if (s.core.kind === "scenario" && s.core.home) await stopCore(s.core.home, { terminals: true });
    fs.rmSync(stateFile(), { force: true });
  }
  console.log("Phone stopped.");
}

function status() {
  const s = running();
  if (!s) return console.log("The phone isn't running. Start it with pnpm phone start.");
  console.log(`Running (pid ${s.pid}): ${s.device} in ${s.browser}`);
  console.log(`Web client: ${s.web}  cores at: ${s.socket}`);
  console.log(`Core: ${where(s)}`);
  console.log(`Paired: device ${s.deviceId} (${s.pairing === "kept" ? "kept from before" : "paired at this start"})`);
  console.log(`Log: ${logFile()}`);
}

if (command === "help" || flags.help) console.log(HELP);
else if (command === "start") await start();
else if (command === "stop") await stop();
else if (command === "status") status();
else {
  const r = await send(command, args, flags);
  (r.ok ? console.log : console.error)(r.out);
  if (!r.ok) process.exitCode = 1;
}

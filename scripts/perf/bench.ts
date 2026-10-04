// Headless performance bench: a real core and PTY host in a throwaway CMD_HOME,
// driven over the socket like one app window, measured from outside with the
// procinfo helper (CPU time and memory of the core and the PTY host).
//   node --no-warnings scripts/perf/bench.ts [idle|flood|memory|search|all] [--panes N] [--label NAME]
// Results print as a table and are appended to .cmd-dev/perf/results.jsonl, so
// runs before and after a change can be compared (docs/14-performance.md).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CoreEvent, PaneId } from "../../packages/protocol/src/index.ts";
import { connect, type Connection } from "../../packages/protocol/src/node.ts";
import { stopCore } from "../stop-core.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const scenario = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")) ?? "all";
const PANES = Number(opt("panes", "10"));
const LABEL = opt("label", "");
const IDLE_SECONDS = Number(opt("seconds", "20"));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-bench-"));
process.env.CMD_HOME = home;
process.env.CMD_INSTANCE = "dev";
delete process.env.CMD_SOCKET;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── measuring other processes: the procinfo helper (ps is unavailable in some sandboxes) ──

const procinfo = path.join(root, "packages/core/native/build/procinfo");
interface Usage {
  pid: number;
  /** bytes */
  mem: number;
  /** cumulative CPU, ns */
  cpu: number;
}
function usage(pids: number[]): Map<number, Usage> {
  const out = spawnSync(procinfo, [], { input: `p ${pids.join(" ")}\n`, encoding: "utf8" }).stdout;
  const rows = JSON.parse(out.split("\n")[0] || "[]") as Usage[];
  return new Map(rows.map((r) => [r.pid, r]));
}

// ── the core under test ──

interface Under {
  conn: Connection;
  core: number;
  host: number;
  events: (fn: (e: CoreEvent) => void) => () => void;
}

async function start(settings: Record<string, unknown> = { "search.enabled": false }): Promise<Under> {
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings));
  const env = { ...process.env, CMD_HOME: home, CMD_INSTANCE: "dev" };
  delete env.CMD_SOCKET;
  const child = spawn(process.execPath, ["--no-warnings", path.join(root, "packages/core/src/main.ts"), "--instance=dev"], { env, stdio: "ignore", detached: true });
  child.unref();
  const sock = path.join(home, "core.sock");
  let conn: Connection | null = null;
  for (let i = 0; i < 200 && !conn; i++) {
    try {
      conn = await connect(sock);
    } catch {
      await sleep(50);
    }
  }
  if (!conn) throw new Error("core did not start");
  const listeners = new Set<(e: CoreEvent) => void>();
  conn.client.onEvent((e) => listeners.forEach((fn) => fn(e)));
  await conn.client.call("events.subscribe", {});
  const info = await conn.client.call("core.info", {});
  return {
    conn,
    core: info.pid,
    host: info.ptyHost?.pid ?? info.pid,
    events: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
}

async function stop(u: Under): Promise<void> {
  u.conn.close();
  await stopCore(home, { terminals: true });
}

/** Wait until `pattern` shows up in a pane's output (as one app window would receive it). */
function waitFor(u: Under, paneId: PaneId, pattern: string, timeoutMs = 120_000): Promise<{ bytes: number }> {
  return new Promise((resolve, reject) => {
    let tail = "";
    let bytes = 0;
    const t = setTimeout(() => (off(), reject(new Error(`timed out waiting for ${pattern}`))), timeoutMs);
    const off = u.events((e) => {
      if (e.type !== "pane.output" || e.paneId !== paneId) return;
      bytes += e.data.length;
      tail = (tail + e.data).slice(-4096);
      if (tail.includes(pattern)) clearTimeout(t), off(), resolve({ bytes });
    });
  });
}

/** A marker the typed command line doesn't contain (only the command's output does). */
const MARK = "BENCH-DONE";
const printMark = `printf '%s\\n' BENCH"-"DONE`;

async function shell(u: Under, cols = 120, rows = 40): Promise<PaneId> {
  const pane = await u.conn.client.call("pane.create", { cols, rows });
  const ready = waitFor(u, pane.id, MARK, 20_000);
  await u.conn.client.call("pane.write", { paneId: pane.id, data: `${printMark}\r` });
  await ready;
  return pane.id;
}

function sample(u: Under) {
  const m = usage([u.core, u.host]);
  return { at: performance.now(), core: m.get(u.core)!, host: m.get(u.host)! };
}
type Sample = ReturnType<typeof sample>;
const cpuPct = (a: Sample, b: Sample, k: "core" | "host") => ((b[k].cpu - a[k].cpu) / 1e6 / (b.at - a.at)) * 100;
const cpuSec = (a: Sample, b: Sample, k: "core" | "host") => (b[k].cpu - a[k].cpu) / 1e9;
const mb = (n: number) => n / 1024 / 1024;

// ── scenarios ──

type Result = Record<string, number | string>;

/** N idle shells at their prompt: what the core and host cost doing nothing. */
async function idle(u: Under): Promise<Result> {
  for (let i = 0; i < PANES; i++) await shell(u);
  await sleep(3000);
  const a = sample(u);
  let events = 0;
  const off = u.events(() => events++);
  await sleep(IDLE_SECONDS * 1000);
  off();
  const b = sample(u);
  return {
    panes: PANES,
    "core cpu %": cpuPct(a, b, "core"),
    "host cpu %": cpuPct(a, b, "host"),
    "events/s": events / IDLE_SECONDS,
    "core MB": mb(b.core.mem),
    "host MB": mb(b.host.mem),
  };
}

/** One pane prints a large file: throughput and CPU per MB through host → core → client. */
async function flood(u: Under): Promise<Result> {
  const file = path.join(home, "flood.txt");
  const line = (i: number) => `\x1b[32m${String(i).padStart(8)}\x1b[0m \x1b[1mlorem ipsum\x1b[0m dolor sit amet, consectetur adipiscing elit ${"x".repeat(i % 40)}\n`;
  const chunks: string[] = [];
  for (let i = 0; i < 300_000; i++) chunks.push(line(i));
  fs.writeFileSync(file, chunks.join(""));
  const size = fs.statSync(file).size;
  const pane = await shell(u);
  await sleep(500);
  const done = waitFor(u, pane, MARK);
  const a = sample(u);
  await u.conn.client.call("pane.write", { paneId: pane, data: `cat ${file}; ${printMark}\r` });
  const { bytes } = await done;
  const b = sample(u);
  const secs = (b.at - a.at) / 1000;
  return {
    "file MB": mb(size),
    seconds: secs,
    "MB/s": mb(size) / secs,
    "received MB": mb(bytes),
    "core cpu s/MB": cpuSec(a, b, "core") / mb(size),
    "host cpu s/MB": cpuSec(a, b, "host") / mb(size),
    "core MB": mb(b.core.mem),
    "host MB": mb(b.host.mem),
  };
}

/** N panes with full scrollback: memory per terminal. */
async function memory(u: Under): Promise<Result> {
  const before = sample(u);
  const panes: PaneId[] = [];
  for (let i = 0; i < PANES; i++) panes.push(await shell(u));
  await sleep(1000);
  const base = sample(u);
  // 12000 lines of 100 columns each: more than the default scrollback (10000).
  for (const p of panes) {
    const done = waitFor(u, p, MARK);
    await u.conn.client.call("pane.write", { paneId: p, data: `for i in {1..12000}; do printf '%06d %s\\n' $i ${"m".repeat(92)}; done; ${printMark}\r` });
    await done;
  }
  await sleep(2000);
  const full = sample(u);
  return {
    panes: PANES,
    "core MB (empty)": mb(base.core.mem),
    "host MB (no panes)": mb(before.host.mem),
    "host MB (idle panes)": mb(base.host.mem),
    "host MB (full)": mb(full.host.mem),
    "host MB/pane": mb(full.host.mem - before.host.mem) / PANES,
    "core MB (full)": mb(full.core.mem),
  };
}

/** Transcript search: a first index from scratch, then a start with the index already built. */
async function search(): Promise<Result> {
  const r: Result = {};
  for (const pass of ["cold", "warm"]) {
    const u = await start({ "search.enabled": true });
    const a = sample(u);
    let peak = a.core.mem;
    for (;;) {
      await sleep(500);
      const s = await u.conn.client.call("search.status", {});
      peak = Math.max(peak, sample(u).core.mem);
      if (!s.indexing && s.sessions > 0) break;
    }
    const b = sample(u);
    r[`${pass} seconds`] = (b.at - a.at) / 1000;
    r[`${pass} core cpu s`] = cpuSec(a, b, "core");
    r[`${pass} peak core MB`] = mb(peak);
    await sleep(5000);
    const c = sample(u);
    await sleep(10_000);
    const d = sample(u);
    r[`${pass} core MB after`] = mb(d.core.mem);
    r[`${pass} idle core cpu %`] = cpuPct(c, d, "core");
    await stop(u);
  }
  return r;
}

/** What a window waits for at startup: snapshots of N terminals with some scrollback, asked in parallel. */
async function snapshot(u: Under): Promise<Result> {
  const panes: PaneId[] = [];
  for (let i = 0; i < PANES; i++) panes.push(await shell(u));
  for (const p of panes) {
    const done = waitFor(u, p, MARK);
    await u.conn.client.call("pane.write", { paneId: p, data: `for i in {1..3000}; do echo "\\033[3$((i % 7))mline $i\\033[0m of some output"; done; ${printMark}\r` });
    await done;
  }
  await sleep(500);
  const times: number[] = [];
  let bytes = 0;
  for (let round = 0; round < 5; round++) {
    const t0 = performance.now();
    const snaps = await Promise.all(panes.map((paneId) => u.conn.client.call("pane.snapshot", { paneId })));
    times.push(performance.now() - t0);
    bytes = snaps.reduce((n, s) => n + s.data.length, 0);
  }
  times.sort((a, b) => a - b);
  return { panes: PANES, "all snapshots ms (median)": times[2]!, "first ms": times[0]!, "KB total": bytes / 1024 };
}

const scenarios: Record<string, (u: Under) => Promise<Result>> = { idle, flood, memory, snapshot };
const run = scenario === "all" ? [...Object.keys(scenarios), "search"] : [scenario];
const out = path.join(root, ".cmd-dev/perf/results.jsonl");
fs.mkdirSync(path.dirname(out), { recursive: true });
const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

for (const name of run) {
  if (name === "search") {
    report(name, await search());
    continue;
  }
  const fn = scenarios[name];
  if (!fn) throw new Error(`unknown scenario: ${name} (idle, flood, memory, all)`);
  const u = await start();
  try {
    report(name, await fn(u));
  } finally {
    await stop(u);
  }
}
if (args.includes("--keep")) console.log(`state kept in ${home}`);
else fs.rmSync(home, { recursive: true, force: true });

function report(name: string, r: Result): void {
  const rounded = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 1000) / 1000 : v]));
  console.log(`\n${name}${LABEL ? ` (${LABEL})` : ""}`);
  console.table(rounded);
  fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), commit, label: LABEL, scenario: name, ...rounded }) + "\n");
}

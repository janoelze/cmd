// Stress a running core and report request latency per load phase, with the
// stalls the core's watchdog blamed (docs/34-startup-scheduler.md). One client
// pings every 20 ms; the phases add load one after another: the startup jobs
// (view rebuilds of a first launch), a first transcript pass, 30 terminals
// printing, journal reloads with searches, query floods, idle. Afterwards, the
// core's log has the whole picture: `grep '\[lag\]' $CMD_HOME/logs/core.log`.
//
//   node scripts/perf/stress-core.mjs <core.sock> [journal]
//
// With `journal`, only the startup jobs and then journal syncs as the core runs
// them every 5 minutes (the first, in the startup job, reads 30 days of git; the
// ones after are the steady state); `journal synced` lines in core.log say
// where each sync's time went.
//
// Run it against a core on a copy of a big log, started like this:
//
//   mkdir -p ~/src/.cmdstress/data && cp "~/Library/Application Support/cmd/data/events.sqlite" ~/src/.cmdstress/data/
//   CMD_HOME=~/src/.cmdstress CMD_USAGE_URL=off node --no-warnings packages/core/src/main.ts --instance=dev
//
// Copy only data/events.sqlite (a VACUUM INTO copy while the app runs): never
// cmd.sqlite, which would resurrect the person's panes and resume their agents.
// A short CMD_HOME: a socket path over 104 characters doesn't bind on macOS.
// Delete data/views.sqlite between runs to get the first-launch rebuilds again.

import net from "node:net";

const sock = process.argv[2];
const only = process.argv[3] ?? null;
if (!sock) {
  console.error("usage: node scripts/perf/stress-core.mjs <core.sock>");
  process.exit(2);
}
const t0 = Date.now();

const connect = async () => {
  for (;;) {
    const c = await new Promise((res) => {
      const c = net.connect(sock);
      c.once("connect", () => res(c));
      c.once("error", () => res(null));
    });
    if (c) return c;
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** A JSON-RPC client over the socket; `events` counts the notifications it received (a UI gets pane.output and the rest). */
const client = async () => {
  const c = await connect();
  let buf = "";
  let id = 0;
  const pend = new Map();
  const events = [];
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.id == null) {
        events.push(r.params?.type);
        continue;
      }
      const p = pend.get(r.id);
      if (!p) continue;
      pend.delete(r.id);
      r.error ? p[1](new Error(r.error.message)) : p[0](r.result);
    }
  });
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pend.set(i, [res, rej]);
      c.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    });
  return { call, events, close: () => c.end() };
};

const ui = await client();
const pinger = await client();
const loader = await client();
await ui.call("core.hello");
console.log(`connected +${Date.now() - t0}ms`);
await ui.call("events.subscribe", {});

let lat = [];
let pinging = true;
void (async () => {
  while (pinging) {
    const t = performance.now();
    await pinger.call("core.hello").catch(() => {});
    lat.push(performance.now() - t);
    await new Promise((r) => setTimeout(r, 20));
  }
})();

const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, every = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(every);
  }
  return false;
};

/** Runs a phase and prints its latency percentiles and the stalls the core kept from it (core.info.stalls holds the last 20). */
const phase = async (name, run) => {
  lat = [];
  const start = Date.now();
  const evBefore = ui.events.length;
  await run();
  const a = lat;
  const info = await loader.call("core.info");
  const stalls = info.stalls.filter((s) => s.at >= start - 200);
  const by = {};
  for (const s of stalls) by[s.in] = (by[s.in] ?? 0) + 1;
  console.log(`\n== ${name} (${((Date.now() - start) / 1000).toFixed(0)}s, ${ui.events.length - evBefore} events to the UI)`);
  console.log(`   pings ${a.length}  p50 ${pct(a, 0.5).toFixed(0)}ms  p95 ${pct(a, 0.95).toFixed(0)}ms  max ${pct(a, 1).toFixed(0)}ms  over100 ${a.filter((x) => x > 100).length}`);
  console.log(`   stalls kept: ${stalls.length}${stalls.length ? ` (longest ${Math.max(...stalls.map((s) => s.ms))}ms) by: ${Object.entries(by).map(([k, v]) => `${k}×${v}`).join(", ")}` : ""}`);
};

await phase("P0 startup jobs (view rebuilds)", () => until(async () => (await loader.call("core.info")).startup.phase === "ready", 600_000, 500));
const journalSyncs = () =>
  phase("PJ journal syncs", async () => {
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      await loader.call("journal.sync").catch(() => {});
      console.log(`   sync ${i}: ${(performance.now() - t).toFixed(0)}ms`);
      await sleep(2000);
    }
  });
if (only === "journal") {
  await journalSyncs();
  pinging = false;
  for (const c of [ui, pinger, loader]) c.close();
  process.exit(0);
}
await phase("P1 first transcript pass", async () => {
  await sleep(1000);
  const done = await until(async () => {
    const s = await loader.call("search.status");
    return !s.indexing && s.files > 0;
  }, 600_000, 1000);
  console.log(done ? "   (pass finished)" : "   (pass still running after 10 min)");
});
await phase("P2 30 chatty terminals", async () => {
  const panes = [];
  for (let i = 0; i < 30; i++) panes.push(await loader.call("pane.create", { command: "sh -c 'i=0; while [ $i -lt 3000 ]; do echo \"line $i of pane output with some text to parse\"; i=$((i+1)); done; sleep 30'" }));
  await sleep(30_000);
  for (const p of panes) await loader.call("pane.kill", { paneId: p.id }).catch(() => {});
});
await phase("P3 journal reloads + searches", async () => {
  const end = Date.now() + 30_000;
  const words = ["wireguard", "journal sync", "tailscle", "notification", "playwright", "sessions rebuild"];
  let n = 0;
  while (Date.now() < end) {
    await loader.call("journal.days", { scope: "all", count: 7, write: "never" }).catch(() => {});
    await loader.call("journal.week", { scope: "all", date: Date.now(), write: "never" }).catch(() => {});
    await loader.call("search.query", { text: words[n++ % words.length], limit: 40 }).catch(() => {});
    await sleep(200);
  }
});
await journalSyncs();
await phase("P4 query floods", async () => {
  const end = Date.now() + 30_000;
  const subs = [];
  for (let i = 0; i < 5; i++) subs.push(await loader.call("data.subscribe", { query: { by: "time", order: "desc", limit: 200 } }));
  while (Date.now() < end) {
    await loader.call("data.query", { query: { types: ["transcript.message"], at: [Date.now() - 7 * 86400e3, Date.now()], limit: 500 } }).catch(() => {});
    await loader.call("data.query", { query: { text: "error", limit: 100 } }).catch(() => {});
    await loader.call("journal.events", { since: Date.now() - 3 * 86400e3 }).catch(() => {});
  }
  for (const s of subs) await loader.call("data.unsubscribe", { id: s.id }).catch(() => {});
});
await phase("P5 idle", () => sleep(20_000));

pinging = false;
ui.close();
pinger.close();
loader.close();

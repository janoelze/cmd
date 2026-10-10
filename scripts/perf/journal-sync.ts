// Profile the journal's git sync offline, on a copy of an event log (data/ only,
// never cmd.sqlite): a first sync (30 days of git), then steady-state syncs as
// the core runs every 5 minutes, with the watchdog's stalls per part.
//   node --no-warnings scripts/perf/journal-sync.ts <copy of data/events.sqlite> [syncs]
import inspector from "node:inspector";
import { DataService } from "../../packages/core/src/data/service.ts";
import { JournalStore } from "../../packages/core/src/journal/store.ts";
import { JournalService } from "../../packages/core/src/journal/service.ts";
import { Scheduler } from "../../packages/core/src/scheduler.ts";
import { DEFAULT_SETTINGS } from "../../packages/protocol/src/index.ts";
import { initLog } from "../../packages/protocol/src/log.ts";

initLog("journal-sync");

const file = process.argv[2];
if (!file) throw new Error("usage: journal-sync.ts <events.sqlite> [syncs]");
const n = Number(process.argv[3] ?? 4);
const data = new DataService({ file, recordedBy: "perf", settings: () => DEFAULT_SETTINGS });
// After opening the log: its first open (indexes) isn't the sync's.
const scheduler = new Scheduler();
const stalls: { ms: number; in: string }[] = [];
scheduler.on("stall", (s) => stalls.push({ ms: s.ms, in: s.in }));
const store = new JournalStore(null, { data });
const j = new JournalService({ store, workspaces: () => [], agentWorkspace: () => null, ai: null, pace: scheduler });
// The steady-state syncs are CPU-profiled: self time per function, summed.
const session = new inspector.Session();
session.connect();
const post = <T,>(m: string, p?: object) => new Promise<T>((res, rej) => session.post(m, p ?? {}, (err, r) => (err ? rej(err) : res(r as T))));
await post("Profiler.enable");
for (let i = 0; i < n; i++) {
  if (i === 1) await post("Profiler.start");
  stalls.length = 0;
  const t = performance.now();
  await j.sync();
  await new Promise((r) => setTimeout(r, 300));
  console.log(`sync ${i}: ${(performance.now() - t - 300).toFixed(0)} ms; stalls: ${stalls.map((s) => `${s.ms} ms in ${s.in}`).join(", ") || "none"}`);
}
type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number };
const { profile } = await post<{ profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] } }>("Profiler.stop");
const self = new Map<number, number>();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));
const by = new Map<string, number>();
for (const node of profile.nodes) {
  const f = node.callFrame;
  const k = `${f.functionName || "(anonymous)"} ${f.url.split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
  by.set(k, (by.get(k) ?? 0) + (self.get(node.id) ?? 0));
}
console.log(`\nself time over ${n - 1} steady syncs:`);
for (const [k, ms] of [...by].filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)")).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${ms.toFixed(1).padStart(8)} ms  ${k}`);
process.exit(0);

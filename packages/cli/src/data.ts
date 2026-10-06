// `cmd data …`: the event log from the command line (docs/28). What's kept and
// how big it is, what each class of data is and whether it leaves the Mac, the
// events themselves by one query, and export/import as JSONL. Agents read it
// too, so the default output is plain lines; --json for the data.

import fs from "node:fs";
import type { DataEvent, DataQuery } from "@cmd/protocol";
import type { Connection } from "@cmd/protocol/node";

type Client = Connection["client"];

export const DATA_HELP = `  data stats                          what the event log holds and how big it is
  data explain                        every class of recorded data: kept how long, its switch, whether it leaves this Mac
  data query [--type T,…] [--since 7d] [--project PATH] [--session ID] [--agent ID] [--text WORDS] [--limit N] [--json]
                                      events, oldest first; types may be prefixes ("git.")
  data subscribe --view turns|sessions [--agent ID] [--session AGENT:ID] [--project PATH] [--json]
                                      a view's rows as they change: turns as agents work, sessions as transcripts grow
  data subscribe [--type T,…] [--since 7d] [--project PATH] [--text WORDS] [--json]
                                      events as they're recorded, one line each (Ctrl-C to stop)
  data ai [--since 30d]               model calls by purpose: how many, tokens in and out, failures, what was cut to fit
  data entities KIND [ID] [--limit N] [--json]
                                      agents, sessions, projects, panes, windows, spaces: what they are and what they link to
  data forget [--session AGENT:ID] [--project PATH] [--before DATE] [--type T,…]
                                      delete what's named, for good; a forgotten session or project is never recorded again
  data rebuild turns|sessions         a view from the log again, with the current rules
  data prune --rules                  remove what the data.exclude setting says never to keep
  data export [--since 30d] [--out FILE]
                                      every event as JSONL (one line each, the envelope and its data; blobs by hash)
  data import FILE                    events from an export`;

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
/** MM-DD HH:MM in local time (YYYY-MM-DD HH:MM with `year`). */
export const when = (t: number, year = false) => {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${year ? `${d.getFullYear()}-` : ""}${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** "7d", "12h", "30m" or a number of days. */
function sinceOf(v: unknown): number | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const m = /^(\d+)([dhm]?)$/.exec(v);
  if (!m) throw new Error(`--since takes a number of days, or Nd, Nh, Nm: not "${v}"`);
  const n = Number(m[1]);
  const unit = m[2] === "h" ? 3600_000 : m[2] === "m" ? 60_000 : 86400_000;
  return Date.now() - n * unit;
}

function queryOf(opt: Record<string, unknown>): DataQuery {
  const q: DataQuery = {};
  if (typeof opt.type === "string") q.types = opt.type.split(",").map((t) => t.trim()).filter(Boolean);
  const since = sinceOf(opt.since);
  if (since) q.at = [since, Date.now() + 86400_000];
  if (typeof opt.project === "string") q.projectId = `dir:${opt.project.replace(/^~/, process.env.HOME ?? "~")}`;
  if (typeof opt.session === "string") q.sessionId = opt.session;
  if (typeof opt.agent === "string") q.agentId = opt.agent;
  if (typeof opt.space === "string") q.spaceId = opt.space;
  if (typeof opt.text === "string") q.text = opt.text;
  if (typeof opt.limit === "string") q.limit = Math.max(1, Number(opt.limit));
  return q;
}

const line = (e: DataEvent) => `${when(e.at)}  ${e.type.padEnd(18)} ${e.projectId ? tilde(e.projectId.slice(4)).split("/").pop()!.padEnd(16) : " ".repeat(16)} ${(e.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`;

export async function dataCommand(client: Client, pos: string[], opt: Record<string, unknown>): Promise<number> {
  const [sub, ...rest] = pos;
  const json = !!opt.json;
  switch (sub) {
    case "stats": {
      const s = await client.call("data.stats", {});
      if (json) return console.log(JSON.stringify(s, null, 2)), 0;
      console.log(`${s.events} events${s.file ? ` in ${tilde(s.file)}` : ""} (${mb(s.fileBytes)}); ${s.blobs.count} blobs, ${mb(s.blobs.size)} → ${mb(s.blobs.stored)} stored`);
      console.log(`${s.recent.day} in the last day, ${s.recent.week} in the last week${s.oldest ? `; oldest ${new Date(s.oldest).toISOString().slice(0, 10)}` : ""}`);
      console.log();
      for (const t of s.types.slice(0, 20)) console.log(`  ${t.type.padEnd(22)} ${String(t.rows).padStart(8)}  ${mb(t.bytes).padStart(9)}${t.blobs ? `  ${t.blobs} blobs` : ""}`);
      return 0;
    }
    case "explain": {
      const classes = await client.call("data.explain", {});
      if (json) return console.log(JSON.stringify(classes, null, 2)), 0;
      for (const c of classes) {
        console.log(`${c.title}${c.enabled ? "" : " (off)"} · ${c.events} events · kept ${c.keepDays === null ? "forever" : `${c.keepDays} days`}${c.cap ? ` · content cut at ${Math.round(c.cap / 1000)} KB` : ""}`);
        console.log(`  ${c.description}`);
        console.log(`  types: ${c.types.join(", ")}${c.setting ? ` · switch: ${c.setting}` : ""}`);
        console.log(`  leaves this Mac: ${c.leaves ?? "never"}`);
      }
      return 0;
    }
    case "query": {
      // The newest by when they happened, oldest of those first.
      const events = (await client.call("data.query", { query: { limit: 200, ...queryOf(opt), by: "time", order: "desc" } })).reverse();
      if (json) return console.log(JSON.stringify(events, null, 2)), 0;
      for (const e of events) console.log(line(e));
      if (!events.length) console.log("Nothing recorded for that.");
      return 0;
    }
    case "ai": {
      const since = sinceOf(opt.since ?? "30d")!;
      const calls = await client.call("data.query", { query: { types: ["ai.call"], at: [since, Date.now() + 1], limit: 100_000 } });
      const by = new Map<string, { n: number; failed: number; tin: number; tout: number; cut: number; models: Set<string> }>();
      for (const e of calls) {
        const d = e.data as { purpose: string; model: string; ok: boolean; tokens: { in: number; out: number }; context?: { parts: { cut: boolean }[] } };
        const r = by.get(d.purpose) ?? { n: 0, failed: 0, tin: 0, tout: 0, cut: 0, models: new Set<string>() };
        r.n++, (r.tin += d.tokens.in), (r.tout += d.tokens.out), r.models.add(d.model);
        if (!d.ok) r.failed++;
        if (d.context?.parts.some((p) => p.cut)) r.cut++;
        by.set(d.purpose, r);
      }
      if (json) return console.log(JSON.stringify(Object.fromEntries([...by].map(([k, v]) => [k, { ...v, models: [...v.models] }])), null, 2)), 0;
      if (!by.size) return console.log("No model calls recorded in that time."), 0;
      const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
      for (const [p, r] of [...by].sort((a, b) => b[1].tin - a[1].tin))
        console.log(`  ${p.padEnd(22)} ${String(r.n).padStart(5)} calls  ${k(r.tin).padStart(7)} in  ${k(r.tout).padStart(7)} out${r.failed ? `  ${r.failed} failed` : ""}${r.cut ? `  ${r.cut} cut to fit` : ""}  ${[...r.models].join(", ")}`);
      return 0;
    }
    case "entities": {
      const [kind, id] = rest;
      if (!kind) throw new Error("usage: cmd data entities KIND [ID]   (agent, session, project, pane, window, space)");
      const list = await client.call("data.entities", { kind, id, limit: typeof opt.limit === "string" ? Number(opt.limit) : 20 });
      if (json) return console.log(JSON.stringify(list, null, 2)), 0;
      for (const e of list) {
        const a = e.attrs;
        const name = String(a.title ?? a.name ?? a.path ?? a.root ?? a.kind ?? "");
        console.log(`${e.id}  ${tilde(name).slice(0, 80)}  · seen ${when(e.seen, true)}`);
        if (id) {
          for (const [k, v] of Object.entries(a)) if (v !== null && v !== undefined && v !== "") console.log(`  ${k}: ${typeof v === "string" ? tilde(v) : JSON.stringify(v)}`);
          for (const l of e.links) console.log(`  ${l.from[0] === kind && l.from[1] === e.id ? `${l.kind} → ${l.to[0]} ${l.to[1]}` : `← ${l.from[0]} ${l.from[1]} (${l.kind})`}`);
        }
      }
      if (!list.length) console.log("Nothing of that kind recorded.");
      return 0;
    }
    case "forget": {
      const p: { sessionId?: string; projectId?: string; before?: number; types?: string[] } = {};
      if (typeof opt.session === "string") p.sessionId = opt.session;
      if (typeof opt.project === "string") p.projectId = `dir:${opt.project.replace(/^~/, process.env.HOME ?? "~")}`;
      if (typeof opt.before === "string") {
        const t = Date.parse(opt.before);
        if (Number.isNaN(t)) throw new Error(`--before takes a date (2026-10-01): not "${opt.before}"`);
        p.before = t;
      }
      if (typeof opt.type === "string") p.types = opt.type.split(",").map((t) => t.trim()).filter(Boolean);
      const { events } = await client.call("data.forget", p);
      console.log(json ? JSON.stringify({ events }) : events ? `${events} event${events === 1 ? "" : "s"} forgotten.` : "Nothing matched.");
      return 0;
    }
    case "rebuild": {
      const view = rest[0];
      if (view !== "turns" && view !== "sessions") throw new Error("usage: cmd data rebuild turns|sessions");
      const { rows } = await client.call("data.rebuild", { view });
      console.log(json ? JSON.stringify({ rows }) : `${rows} ${view} rebuilt from the log.`);
      return 0;
    }
    case "prune": {
      if (!opt.rules) throw new Error("usage: cmd data prune --rules");
      const { events } = await client.call("data.applyRules", {});
      console.log(json ? JSON.stringify({ events }) : events ? `${events} event${events === 1 ? "" : "s"} removed.` : "Nothing to remove.");
      return 0;
    }
    case "subscribe": {
      if (opt.view === "turns" || opt.view === "sessions") {
        const q = queryOf(opt);
        const { id, rows } = await client.call("data.subscribeView", { query: { view: opt.view, agentId: q.agentId, sessionId: q.sessionId, projectId: q.projectId, since: q.at?.[0], limit: 20 } });
        const show = (r: (typeof rows)[number]) =>
          console.log(json ? JSON.stringify(r) : "key" in r ? `${r.key.slice(0, 20).padEnd(20)} ${String(r.messages).padStart(5)} msgs  ${(r.title ?? r.firstPrompt ?? "").slice(0, 70)}` : `${r.agentId.slice(0, 8)} #${String(r.index).padEnd(3)} ${r.outcome.padEnd(11)} ${(r.prompt ?? "").replace(/\s+/g, " ").slice(0, 70)}`);
        rows.forEach(show);
        client.onEvent((e) => {
          if (e.type === "view.changed" && e.id === id) e.rows.forEach(show);
        });
        await client.call("events.subscribe", { types: ["view.changed"] });
        await new Promise(() => {});
      }
      const { id, events } = await client.call("data.subscribe", { query: { limit: 50, ...queryOf(opt) } });
      for (const e of events) console.log(json ? JSON.stringify(e) : line(e));
      client.onEvent((e) => {
        if (e.type !== "data.changed" || e.id !== id) return;
        for (const ev of e.events) console.log(json ? JSON.stringify(ev) : line(ev));
      });
      await client.call("events.subscribe", { types: ["data.changed"] });
      await new Promise(() => {}); // until Ctrl-C
    }
    case "export": {
      const out = typeof opt.out === "string" ? fs.createWriteStream(opt.out) : null;
      const write = (s: string) => (out ? out.write(s + "\n") : console.log(s));
      const q = queryOf({ ...opt, since: opt.since ?? "30d" });
      let after = 0;
      let n = 0;
      for (;;) {
        const page = await client.call("data.query", { query: { ...q, after, limit: 2000 } });
        for (const e of page) write(JSON.stringify(e)), n++;
        if (page.length < 2000) break;
        after = page.at(-1)!.seq;
      }
      if (out) await new Promise((r) => out.end(r));
      if (out) console.log(`${n} events written to ${opt.out}`);
      return 0;
    }
    case "import": {
      const file = rest[0];
      if (!file) throw new Error("usage: cmd data import FILE");
      const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
      let imported = 0;
      for (let i = 0; i < lines.length; i += 500) {
        const events = lines.slice(i, i + 500).map((l) => {
          const { seq: _s, recorded: _r, flags: _f, blob: _b, ...e } = JSON.parse(l) as DataEvent;
          return e;
        });
        imported += (await client.call("data.import", { events })).imported;
      }
      console.log(json ? JSON.stringify({ imported }) : `${imported} events imported.`);
      return 0;
    }
    default:
      console.error(DATA_HELP);
      return 2;
  }
}

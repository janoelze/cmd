// `cmd agents …`: what the core recorded about agents (docs/18-agent-activity.md).
// The debugging view of agent state: every event with what it was mapped to,
// turns, coverage per agent, where agents keep their config, recording a
// session as a test fixture, and summarising a session (docs/20-session-summaries.md).

import fs from "node:fs";
import os from "node:os";
import type { ActivityEvent, AgentTurn } from "@cmd/protocol";
import type { Connection } from "@cmd/protocol/node";
import { rawFromLog, toFixture } from "@cmd/core/activity/fixture";

type Client = Connection["client"];

export const AGENTS_HELP = `  agents events <agent|pane> [--raw] [--follow] [--limit N] [--json]
                                      what cmd recorded about an agent, as mapped (--raw: payloads)
  agents turns <agent> [--json]       its turns: prompt, outcome, tools, files, final message
  agents summary <agent> [--open]     summarise its session with AI: prints the Markdown (--open: in a window too)
  agents coverage [--days N] [--json] what each agent's events actually carried
  agents homes [--rescan] [--json]    where agents keep their config (found by cmd)
  agents record <agent> <out.jsonl>   its events as a test fixture (paths rewritten)
  agents export [--days N] [--anonymize] [--out FILE]
                                      everything recorded, as versioned JSONL (default: stdout)`;

const time = (t: number) => new Date(t).toTimeString().slice(0, 8);
const one = (s: string, n = 90) => {
  const l = (s.split(/\r?\n/).find((x) => x.trim()) ?? "").trim();
  return l.length > n ? l.slice(0, n - 1) + "…" : l;
};

/** A live agent (or pane) by id prefix or name; else the argument as a full id (agents that are gone keep their events). */
async function target(client: Client, ref: string): Promise<{ agentId?: string; paneId?: string }> {
  const [agents, panes] = await Promise.all([client.call("agent.list", {}), client.call("pane.list", {})]);
  const a = agents.filter((x) => x.id.startsWith(ref) || x.name === ref);
  if (a.length === 1) return { agentId: a[0]!.id };
  if (a.length > 1) throw new Error(`ambiguous agent: ${ref}`);
  const p = panes.filter((x) => x.id.startsWith(ref));
  if (p.length === 1) return p[0]!.agentId ? { agentId: p[0]!.agentId } : { paneId: p[0]!.id };
  // Gone: an agent id (prefix) in the log, else a pane's.
  return (await client.call("agent.events", { agentId: ref, limit: 1 })).length ? { agentId: ref } : { paneId: ref };
}

export function eventLine(e: ActivityEvent): string {
  const what = e.tool ? [e.tool.label ?? e.tool.name, e.tool.ok === false ? "(failed)" : "", e.tool.writes ? `[writes: ${e.tool.writes}]` : ""].filter(Boolean).join(" ") : e.text ? one(e.text) : "";
  const tags = [e.subagent ? `sub:${e.subagent.slice(0, 6)}` : "", e.auto ? "auto" : "", e.background?.length ? `bg:${e.background.length}` : "", e.source === "core" ? "core" : ""].filter(Boolean).join(" ");
  return `${String(e.id).padStart(6)} ${time(e.at)} ${e.kind.padEnd(14)} ${e.name.padEnd(18)} ${tags ? `(${tags}) ` : ""}${what}`;
}

function turnLines(t: AgentTurn): string[] {
  const dur = t.endedAt ? `${Math.round((t.endedAt - t.startedAt) / 1000)} s` : "running";
  const tools = t.tools.map((x) => `${x.name}×${x.count}${x.failed ? ` (${x.failed} failed)` : ""}`).join(", ");
  const out = [`#${t.index} ${time(t.startedAt)} ${t.outcome} (${dur})${t.auto ? " auto" : ""}  ${t.prompt ? one(t.prompt, 70) : "(no prompt seen)"}`];
  if (tools) out.push(`   tools  ${tools}${t.shellWrites ? `; ${t.shellWrites} shell write${t.shellWrites > 1 ? "s" : ""}` : ""}`);
  for (const f of t.files.slice(0, 12)) out.push(`   ${f.change.padEnd(2)} ${f.path}  (${f.via.join("+")})`);
  if (t.files.length > 12) out.push(`   … ${t.files.length - 12} more files`);
  if (t.ask) out.push(`   asked  ${one(t.ask.message)}${t.ask.input ? `: ${one(t.ask.input, 60)}` : ""}`);
  if (t.error) out.push(`   error  ${one(t.error)}`);
  if (t.final) out.push(`   final  ${one(t.final)}`);
  if (t.background.length) out.push(`   left running  ${t.background.join("; ")}`);
  if (t.inferred.length) out.push(`   inferred  ${t.inferred.join("; ")}`);
  return out;
}

export async function agentsCommand(client: Client, closed: Promise<void>, pos: string[], opt: Record<string, unknown>): Promise<number> {
  const [sub, ref, file] = pos;
  const json = !!opt.json;
  const limit = typeof opt.limit === "string" ? Number(opt.limit) : undefined;
  switch (sub) {
    case "events": {
      if (!ref) throw new Error("usage: cmd agents events <agent|pane>");
      const t = await target(client, ref);
      const evs = await client.call("agent.events", { ...t, raw: !!opt.raw, limit: limit ?? 200 });
      const print = (e: ActivityEvent) => console.log(json ? JSON.stringify(e) : eventLine(e) + (opt.raw && e.raw ? `\n${JSON.stringify(e.raw)}` : ""));
      evs.forEach(print);
      if (!opt.follow) return 0;
      client.onEvent((e) => {
        if (e.type !== "agent.activity") return;
        if ((t.agentId && e.event.agentId === t.agentId) || (t.paneId && e.event.paneId === t.paneId)) print(e.event);
      });
      await client.call("events.subscribe", {});
      await closed;
      return 0;
    }
    case "summary": {
      if (!ref) throw new Error("usage: cmd agents summary <agent>");
      const { agentId } = await target(client, ref);
      if (!agentId) throw new Error(`no agent: ${ref}`);
      const r = await client.call("agent.summarize", { agentId, open: !!opt.open, wait: true });
      if (json) return console.log(JSON.stringify(r, null, 2)), 0;
      console.log(r.markdown ?? "");
      console.error(r.path);
      return 0;
    }
    case "turns": {
      if (!ref) throw new Error("usage: cmd agents turns <agent>");
      const { agentId } = await target(client, ref);
      const turns = agentId ? await client.call("agent.turns", { agentId, limit }) : [];
      if (json) return console.log(JSON.stringify(turns, null, 2)), 0;
      if (!turns.length) console.log("no turns recorded");
      for (const t of turns) console.log(turnLines(t).join("\n"));
      return 0;
    }
    case "coverage": {
      const days = typeof opt.days === "string" ? Number(opt.days) : undefined;
      const cov = await client.call("agents.coverage", { days });
      if (json) return console.log(JSON.stringify(cov, null, 2)), 0;
      for (const c of cov) {
        console.log(`${c.agent}: ${c.events} events, ${c.sessions} sessions${c.anomalies ? `, ${c.anomalies} anomalies` : ""}`);
        console.log(`  kinds   ${Object.entries(c.kinds).map(([k, n]) => `${k} ${n}`).join(", ")}`);
        const weak = Object.entries(c.fields).filter(([, v]) => v < 1);
        if (weak.length) console.log(`  missing ${weak.map(([k, v]) => `${k} ${Math.round((1 - v) * 100)}%`).join(", ")}`);
        if (c.unmapped.length) console.log(`  unmapped events: ${c.unmapped.join(", ")}`);
      }
      if (!cov.length) console.log("no events recorded yet");
      return 0;
    }
    case "homes": {
      const homes = await client.call("agents.homes", { rescan: !!opt.rescan });
      if (json) return console.log(JSON.stringify(homes, null, 2)), 0;
      for (const h of homes) console.log(`${h.agent.padEnd(7)} ${h.dir}  (${h.via.join(", ")})${h.env ? `  ${Object.entries(h.env).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`);
      return 0;
    }
    case "export": {
      const days = typeof opt.days === "string" ? Number(opt.days) : undefined;
      const out = typeof opt.out === "string" ? fs.createWriteStream(opt.out) : process.stdout;
      const write = (v: unknown) => new Promise<void>((r) => (out.write(JSON.stringify(v) + "\n") ? r() : out.once("drain", () => r())));
      let afterId: number | undefined;
      let events = 0;
      let turns = 0;
      for (;;) {
        const page = await client.call("agents.export", { days, anonymize: !!opt.anonymize, afterId });
        if (afterId === undefined) {
          await write(page.header);
          for (const t of page.turns) await write({ type: "turn", ...t });
          turns = page.turns.length;
        }
        for (const e of page.events) await write({ type: "event", ...e });
        events += page.events.length;
        if (page.next === null) break;
        afterId = page.next;
      }
      if (out !== process.stdout) {
        await new Promise((r) => (out as fs.WriteStream).end(r));
        console.error(`${events} events, ${turns} turns → ${opt.out}`);
      }
      return 0;
    }
    case "record": {
      if (!ref || !file) throw new Error("usage: cmd agents record <agent> <out.jsonl>");
      const t = await target(client, ref);
      const evs = await client.call("agent.events", { ...t, raw: true, limit: 100_000 });
      const raws = rawFromLog(evs);
      if (!raws.length) throw new Error("no events recorded for it");
      const cwd = evs.find((e) => e.cwd)?.cwd;
      const first = evs.find((e) => e.source === "hook");
      const meta = { agent: first?.agent ?? null, agentVersion: evs.find((e) => e.agentVersion)?.agentVersion ?? null, recordedBy: first?.recorded?.cmd ?? null, hook: first?.recorded?.hook ?? null };
      fs.writeFileSync(file, toFixture(raws, { ...(cwd ? { [cwd]: "/work/repo" } : {}), [os.homedir()]: "/Users/me" }, meta));
      console.log(`${raws.length} events → ${file}${cwd ? ` (${cwd} → /work/repo)` : ""}`);
      return 0;
    }
    default:
      console.log(`usage:\n${AGENTS_HELP}`);
      return sub ? 1 : 0;
  }
}

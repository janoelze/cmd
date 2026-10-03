// `cmd`: the CLI over the core socket. Used by humans, hooks and host agents.

import path from "node:path";
import { parseArgs } from "node:util";
import type { Agent, AgentState, Pane } from "@cmd/protocol";
import { APPLIES_LABEL, currentKey, ENV, SETTINGS_SCHEMA, isSettingKey, parseSettingValue, type SettingDef, type SettingKey } from "@cmd/protocol";
import { connect, defaultSocketPath, type Connection } from "@cmd/protocol/node";
import { magicCommand } from "./magic.ts";

const HELP = `cmd — terminal + agent workbench

usage: cmd <command> [options]

  ls [--json]                         panes and their agents (tree)
  identify [--json]                   this pane and agent (inside cmd)
  new [--cwd DIR] [-- COMMAND…]       open a terminal pane
  spawn <kind> [PROMPT] [--name N] [--cwd DIR] [--no-parent] [--json]
                                      start an agent; inside an agent it becomes a child
  send <agent> <text> [--no-submit]   type into an agent and submit
  read <agent|pane> [--lines N]       plain-text tail of the terminal
  wait <agent…> [--until done,needs_input] [--any] [--timeout SECS]
  kill <agent> [--tree]
  notify <message…> [--title T] [--global]
                                      a notification; inside cmd it comes from (and marks) this pane
  events [--output]                   stream core events as NDJSON
  hook <kind>                         hook entry point: reads the hook payload on stdin
  hooks <kind>                        print hook config to add to the agent's settings
  open <path|url> [--kind K] [--types] open in a cmd window (folder, text, browser, …);
                                      --types lists window types
  search <query…> [--json] [--limit N]  search past Claude Code / Codex sessions
  resume <session-id> [--agent claude|codex] [--fork]
  magic <request…> [--help]          make a widget or terminal command from a request
                                      (runs here, no core needed; see cmd magic --help)
  settings [get KEY | set KEY VALUE | reset KEY | path] [--json]
                                      list or change settings (applies live)

env: ${ENV.socket} (default ${defaultSocketPath()})`;

const argv = process.argv.slice(2);
const cmd = argv[0];

const { values: opt, positionals: pos } = parseArgs({
  args: argv.slice(1),
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean" },
    cwd: { type: "string" },
    name: { type: "string" },
    lines: { type: "string" },
    until: { type: "string" },
    any: { type: "boolean" },
    timeout: { type: "string" },
    tree: { type: "boolean" },
    output: { type: "boolean" },
    "no-submit": { type: "boolean" },
    "no-parent": { type: "boolean" },
    limit: { type: "string" },
    agent: { type: "string" },
    fork: { type: "boolean" },
    kind: { type: "string" },
    types: { type: "boolean" },
    title: { type: "string" },
    global: { type: "boolean" },
  },
});

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

async function main(): Promise<number> {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "hook") return hook(pos[0] ?? "claude");
  if (cmd === "hooks") return printHooks(pos[0] ?? "claude");
  if (cmd === "magic") return magicCommand(argv.slice(1));

  const conn = await connect().catch(() => {
    console.error(`cmd: no core running at ${defaultSocketPath()} (start it with: pnpm core)`);
    process.exit(2);
  });
  try {
    return await run(conn);
  } finally {
    conn.close();
  }
}

async function run({ client, closed }: Connection): Promise<number> {
  switch (cmd) {
    case "ls": {
      const [panes, agents] = await Promise.all([client.call("pane.list", {}), client.call("agent.list", {})]);
      if (opt.json) return out({ panes, agents });
      printTree(panes, agents);
      return 0;
    }
    case "identify": {
      const paneId = process.env[ENV.paneId];
      if (!paneId) return fail("not inside a cmd pane");
      const r = await client.call("identify", { paneId });
      if (opt.json) return out(r);
      console.log(`pane  ${r.pane?.id ?? "?"}\nagent ${r.agent?.id ?? "-"}\nparent ${r.agent?.parentId ?? "-"}`);
      return 0;
    }
    case "new": {
      const dash = argv.indexOf("--");
      const command = dash >= 0 ? argv.slice(dash + 1).join(" ") : undefined;
      const pane = await client.call("pane.create", { cwd: str(opt.cwd) ?? process.cwd(), command });
      return out(opt.json ? pane : pane.id);
    }
    case "spawn": {
      const [kind, ...prompt] = pos;
      if (!kind) return fail("usage: cmd spawn <kind> [PROMPT]");
      let parentId: string | null = null;
      if (!opt["no-parent"] && process.env[ENV.paneId]) {
        const me = await client.call("identify", { paneId: process.env[ENV.paneId]! });
        parentId = me.agent?.id ?? null;
      }
      const agent = await client.call("agent.spawn", {
        kind,
        prompt: prompt.join(" ") || undefined,
        name: str(opt.name),
        cwd: str(opt.cwd) ?? process.cwd(),
        parentId,
      });
      return out(opt.json ? agent : agent.id);
    }
    case "notify": {
      const body = pos.join(" ");
      if (!body && !str(opt.title)) return fail("usage: cmd notify <message…> [--title T]");
      const paneId = opt.global ? null : (process.env[ENV.paneId] ?? null);
      await client.call("notify.send", { paneId, title: str(opt.title), body });
      return 0;
    }
    case "send": {
      const [agentId, ...text] = pos;
      if (!agentId || !text.length) return fail("usage: cmd send <agent> <text>");
      await client.call("agent.send", { agentId: await resolveAgent(client, agentId), text: text.join(" "), submit: !opt["no-submit"] });
      return 0;
    }
    case "read": {
      const target = pos[0];
      if (!target) return fail("usage: cmd read <agent|pane>");
      const paneId = await resolvePane(client, target);
      const r = await client.call("pane.read", { paneId, lines: Number(opt.lines ?? 50) });
      process.stdout.write(r.text + "\n");
      return 0;
    }
    case "wait": {
      if (!pos.length) return fail("usage: cmd wait <agent…>");
      const ids = await Promise.all(pos.map((p) => resolveAgent(client, p)));
      const until = (str(opt.until) ?? "done,needs_input,exited,failed").split(",") as AgentState[];
      const r = await client.call("agent.wait", {
        agentIds: ids,
        until,
        mode: opt.any ? "any" : "all",
        timeoutMs: Number(opt.timeout ?? 50) * 1000,
      });
      if (opt.json) out(r);
      else for (const a of r.agents) console.log(`${short(a.id)} ${a.state}${a.lastMessage ? `  ${oneLine(a.lastMessage)}` : ""}`);
      return r.timedOut ? 124 : 0;
    }
    case "kill": {
      if (!pos[0]) return fail("usage: cmd kill <agent>");
      const r = await client.call("agent.kill", { agentId: await resolveAgent(client, pos[0]), tree: !!opt.tree });
      return out(opt.json ? r : r.killed.map(short).join(" "));
    }
    case "open": {
      if (opt.types) {
        const types = await client.call("window.types", {});
        if (opt.json) return out(types);
        for (const t of types) {
          const o = t.opens;
          const what = [o.folders && "folders", o.schemes?.join("/"), o.extensions?.length && `${o.extensions.length} extensions`, o.text && "text"]
            .filter(Boolean)
            .join(", ");
          console.log(`${t.kind.padEnd(16)} ${t.title.padEnd(14)} ${what}`);
        }
        return 0;
      }
      const target = pos[0];
      if (!target) return fail("usage: cmd open <path|url> [--kind K]");
      const abs = /^[a-z][\w+.-]+:/i.test(target) ? target : path.resolve(target);
      const kind = str(opt.kind);
      const w = kind
        ? await client.call("window.open", { kind, input: /^[a-z][\w+.-]+:/i.test(abs) ? { url: abs } : { path: abs } })
        : await client.call("window.openTarget", { target: abs });
      if (!w) return fail(`no cmd window type opens ${target} (try: open ${target})`);
      return out(opt.json ? w : w.id);
    }
    case "search": {
      const text = pos.join(" ");
      if (!text) {
        const st = await client.call("search.status", {});
        return out(opt.json ? st : `${st.sessions} sessions indexed${st.indexing ? ` (indexing ${st.done}/${st.total})` : ""}`);
      }
      const hits = await client.call("search.query", { text, limit: Number(opt.limit ?? 20) });
      if (opt.json) return out(hits);
      for (const h of hits) {
        const when = h.updatedAt ? new Date(h.updatedAt).toISOString().slice(0, 10) : "";
        console.log(`${h.sessionId.slice(0, 8)}  ${h.agent.padEnd(6)} ${when}  ${h.title.slice(0, 70)}`);
        if (h.snippet) console.log(`          ${h.snippet.replace(/\x01/g, "\x1b[1m").replace(/\x02/g, "\x1b[0m").slice(0, 160)}`);
      }
      if (!hits.length) console.log("(no matches)");
      return 0;
    }
    case "resume": {
      const id = pos[0];
      if (!id) return fail("usage: cmd resume <session-id>");
      const hit = (await client.call("search.query", { text: `"${id}"`, limit: 1 })).find((h) => h.sessionId === id);
      const agent = await client.call("agent.resume", {
        agent: (str(opt.agent) as "claude" | "codex") ?? hit?.agent ?? "claude",
        sessionId: id,
        cwd: hit?.cwd ?? process.cwd(),
        configDir: hit?.configDir ?? null,
        fork: !!opt.fork,
      });
      return out(opt.json ? agent : agent.id);
    }
    case "settings": {
      const [sub, key, ...rest] = pos;
      if (sub === "set") {
        if (!key || !rest.length) return fail("usage: cmd settings set KEY VALUE");
        await client.call("settings.set", { key, value: parseSettingValue(key, rest.join(" ")) });
        const k = currentKey(key);
        const applies = isSettingKey(k) && (SETTINGS_SCHEMA[k] as SettingDef).applies;
        if (applies) console.error(`note: ${APPLIES_LABEL[applies]}`);
        return 0;
      }
      if (sub === "reset") {
        if (!key) return fail("usage: cmd settings reset KEY");
        await client.call("settings.reset", { key });
        return 0;
      }
      const snap = await client.call("settings.get", {});
      if (sub === "path") return out(snap.path);
      if (sub === "get") {
        const k = currentKey(key ?? "");
        if (!(k in snap.settings)) return fail(`unknown setting: ${key ?? ""}`);
        return out(JSON.stringify(snap.settings[k as SettingKey]));
      }
      if (opt.json) return out(snap);
      for (const [k, def] of Object.entries(SETTINGS_SCHEMA) as [SettingKey, SettingDef][]) {
        const mark = snap.overrides.includes(k) ? "*" : " ";
        const applies = def.applies ? ` (${APPLIES_LABEL[def.applies]})` : "";
        console.log(`${mark} ${k.padEnd(28)} ${JSON.stringify(snap.settings[k]).padEnd(24)} ${def.description}${applies}`);
      }
      console.log(`\n* = set in ${snap.path}`);
      for (const e of snap.errors) console.error(`warning: ${e}`);
      return 0;
    }
    case "events": {
      client.onEvent((e) => {
        if (e.type === "pane.output" && !opt.output) return;
        process.stdout.write(JSON.stringify(e) + "\n");
      });
      await client.call("events.subscribe", {});
      await closed;
      return 0;
    }
    default:
      return fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

/** Hook entry point. Must never block or fail the agent: always exit 0, fast. */
async function hook(kind: string): Promise<number> {
  const paneId = process.env[ENV.paneId];
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  if (!paneId) return 0;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return 0;
  }
  const event = String(payload.hook_event_name ?? pos[1] ?? "");
  if (!event) return 0;
  const timer = setTimeout(() => process.exit(0), 2000);
  try {
    const conn = await connect();
    await conn.client.call("hook.ingest", { paneId, agent: kind, event, payload });
    conn.close();
  } catch {
    // core not running: ignore
  }
  clearTimeout(timer);
  return 0;
}

function printHooks(kind: string): number {
  const self = process.argv[1]!.replace(/src\/main\.ts$/, "bin/cmd");
  const events = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
  ];
  const entry = (matcher?: string) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: `${self} hook ${kind}`, timeout: 5 }],
  });
  const hooks = Object.fromEntries(
    events.map((e) => [e, [entry(e.endsWith("ToolUse") ? "*" : undefined)]]),
  );
  const file = kind === "codex" ? "~/.codex/hooks.json" : "~/.claude/settings.json";
  console.error(`# merge into ${file} → "hooks" (sandbox wrappers must pass ${ENV.paneId} and ${ENV.socket})`);
  return out({ hooks });
}

async function resolveAgent(client: Connection["client"], prefix: string): Promise<string> {
  const agents = await client.call("agent.list", {});
  const hits = agents.filter((a) => a.id.startsWith(prefix) || a.name === prefix);
  if (hits.length !== 1) throw new Error(hits.length ? `ambiguous agent: ${prefix}` : `no such agent: ${prefix}`);
  return hits[0]!.id;
}

async function resolvePane(client: Connection["client"], prefix: string): Promise<string> {
  const [panes, agents] = await Promise.all([client.call("pane.list", {}), client.call("agent.list", {})]);
  const pane = panes.find((p) => p.id.startsWith(prefix));
  if (pane) return pane.id;
  const agent = agents.find((a) => a.id.startsWith(prefix) || a.name === prefix);
  if (agent?.paneId) return agent.paneId;
  throw new Error(`no such pane or agent: ${prefix}`);
}

function printTree(panes: Pane[], agents: Agent[]): void {
  const byParent = new Map<string | null, Agent[]>();
  for (const a of agents) byParent.set(a.parentId, [...(byParent.get(a.parentId) ?? []), a]);
  const line = (a: Agent, indent: string) => {
    const name = a.name ? ` ${a.name}` : "";
    const detail = a.detail ? `  — ${a.detail}` : "";
    console.log(`${indent}${short(a.id)} ${a.kind}${name} [${a.state}]${a.paneId ? ` pane ${short(a.paneId)}` : " (virtual)"}${detail}`);
    for (const c of byParent.get(a.id) ?? []) line(c, indent + "  ");
  };
  const roots = agents.filter((a) => !a.parentId || !agents.some((p) => p.id === a.parentId));
  for (const r of roots) line(r, "");
  for (const p of panes) if (!p.agentId) console.log(`${short(p.id)} ${p.foreground} — ${p.title}  ${p.cwd}`);
  if (!panes.length && !agents.length) console.log("(nothing running)");
}

const short = (id: string) => id.slice(0, 8);
const oneLine = (s: string) => s.replace(/\s+/g, " ").slice(0, 100);

function out(v: unknown): number {
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return 0;
}

function fail(msg: string): number {
  console.error(`cmd: ${msg}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`cmd: ${(err as Error).message}`);
    process.exit(1);
  },
);

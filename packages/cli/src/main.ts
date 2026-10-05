// `cmd`: the CLI over the core socket. Used by humans, hooks and host agents.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import type { Agent, AgentState, AppWindow, Pane, RemoteDevice, RemotePairRequest, RemoteScope, RemoteStatus, Space } from "@cmd/protocol";
import { renderUnicodeCompact } from "uqr";
import { APPLIES_LABEL, currentKey, currentSecretKey, ENV, isSecretKey, SECRETS, type SecretDef, type SecretKey, SETTINGS_SCHEMA, isSettingKey, parseSettingValue, type SettingDef, type SettingKey } from "@cmd/protocol";
import { connect, defaultSocketPath, type Connection } from "@cmd/protocol/node";
import { magicCommand } from "./magic.ts";
import { widgetCommand } from "./widget.ts";
import { AGENTS_HELP, agentsCommand } from "./agents.ts";

const HELP = `cmd — terminal + agent workbench

usage: cmd <command> [options]

  . | <dir> [-n] [--git-root]         open the folder as a Space (or return to it);
                                      -n: in a new app window, --git-root: the repository's root
  space [ls] [--all] [--json]         open Spaces (--all: recent ones too)
  space which [PATH]                  the Space a path belongs to
  space close|rename|forget [SPACE] [NAME]
  space icon [SPACE] SYMBOL           its icon: an SF Symbol name (- for the default)
                                      SPACE: id prefix, name or folder; default: this terminal's
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
  hooks [--json]                      agent configs (Claude Code, Codex, Gemini) and whether cmd's hook is in them
  hooks install|remove [AGENT|FILE]   add cmd's hook to them (all by default), or take it out
${AGENTS_HELP}
  open <path|url> [--kind K] [--types] open in a cmd window (folder, text, browser, …);
                                      --types lists window types
  search <query…> [--json] [--limit N]  search past agent sessions
  resume <session-id> [--agent claude|codex|…] [--fork]
  magic <request…> [--help]          build a widget (or a terminal command) from a request
                                      (runs here, no core needed; see cmd magic --help)
  widget list | add <widget>          the Widget Library; put a widget on the desk
  widget new|check|run|preview [dir]  make and check Magic widget folders (cmd widget --help)
  settings [get KEY | set KEY VALUE | reset KEY | path] [--json]
                                      list or change settings (applies live)
  settings secret KEY [--clear]       store an API key from stdin (pbpaste | cmd settings secret
                                      ai.anthropic.apiKey); never in settings.json
  remote [status|on|off]              remote access from a phone or browser (end-to-end encrypted):
                                      who is connected and what they're watching
  remote pair                         a one-time QR code; approve the device here
  remote devices | log                paired devices | recent activity
  remote disconnect [DEVICE]          close live sessions (devices stay paired)
  remote revoke DEVICE | scope DEVICE view|control
                                      unpair a device | change what it may do

env: ${ENV.socket} (default ${defaultSocketPath()})`;

const COMMANDS = new Set(["ls", "identify", "new", "spawn", "send", "read", "wait", "kill", "notify", "events", "hook", "hooks", "agents", "open", "search", "resume", "settings", "space", "remote", "help"]);

/**
 * `cmd .`, `cmd ~/src/x`, `cmd ../y`: a folder to open as a Space. A command name
 * always wins (`cmd ./ls` for a folder called ls); a bare word must be an existing folder.
 */
function isFolderArg(a: string | undefined): a is string {
  if (!a || a.startsWith("-") || COMMANDS.has(a)) return false;
  if (a === "." || a === ".." || /^(~|\.{1,2})?\//.test(a) || a === "~") return true;
  try {
    return fs.statSync(a).isDirectory();
  } catch {
    return false;
  }
}

const rawArgv = process.argv.slice(2);
const argv = isFolderArg(rawArgv[0]) ? ["space", "open", ...rawArgv] : rawArgv;
const cmd = argv[0];
/** The terminal this runs in, if inside cmd: new things go to its Space. */
const callerPaneId = process.env[ENV.paneId] || undefined;

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
    all: { type: "boolean" },
    "new-window": { type: "boolean", short: "n" },
    "git-root": { type: "boolean" },
    clear: { type: "boolean" },
    scope: { type: "string" },
    raw: { type: "boolean" },
    follow: { type: "boolean", short: "f" },
    days: { type: "string" },
    rescan: { type: "boolean" },
  },
});

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

async function main(): Promise<number> {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "hook") return hook(pos[0] ?? "claude");
  if (cmd === "magic") return magicCommand(argv.slice(1));
  if (cmd === "widget") return widgetCommand(argv.slice(1));

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
    case "hooks": {
      const sub = pos[0];
      let targets = await client.call("hooks.status", {});
      if (sub === "install" || sub === "remove") {
        const which = pos[1];
        const picked = targets.filter((t) => !which || t.agent === which || t.file === path.resolve(which));
        if (!picked.length) return fail(which ? `no agent config matches ${which}` : "no agent configs found");
        for (const t of picked) targets = await client.call(sub === "install" ? "hooks.install" : "hooks.remove", { file: t.file });
      } else if (sub) {
        return fail(`unknown: hooks ${sub}`);
      }
      if (opt.json) return out(targets);
      const label = { installed: "installed", missing: "not installed", legacy: "old hook (ghostty-agents or cmd hook)", elsewhere: "another cmd's hook" };
      for (const t of targets) console.log(`${t.title.padEnd(12)} ${label[t.state].padEnd(14)} ${t.file}`);
      if (targets.some((t) => t.agent === "codex" && t.state === "installed")) console.log("\nCodex runs a new hook only once you approve it: run /hooks in Codex.");
      return 0;
    }
    case "agents":
      return agentsCommand(client, closed, pos, opt);
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
      const pane = await client.call("pane.create", { cwd: str(opt.cwd) ?? process.cwd(), command, callerPaneId });
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
        callerPaneId: opt["no-parent"] ? undefined : callerPaneId,
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
        ? await client.call("window.open", { kind, input: /^[a-z][\w+.-]+:/i.test(abs) ? { url: abs } : { path: abs }, callerPaneId })
        : await client.call("window.openTarget", { target: abs, callerPaneId });
      if (!w) return fail(`no cmd window type opens ${target} (try: open ${target})`);
      return out(opt.json ? w : w.id);
    }
    case "space":
      return space(client);
    case "remote":
      return remote(client);
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
        agent: str(opt.agent) ?? hit?.agent ?? "claude",
        sessionId: id,
        cwd: hit?.cwd ?? process.cwd(),
        env: hit?.env ?? null,
        fork: !!opt.fork,
        callerPaneId,
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
      if (sub === "secret") {
        // From stdin, so the key stays out of argv and shell history: pbpaste | cmd settings secret KEY
        const secret = key && currentSecretKey(key);
        if (!secret || !isSecretKey(secret)) return fail(`usage: cmd settings secret KEY [--clear]   (KEY: ${Object.keys(SECRETS).join(", ")})`);
        if (opt.clear) {
          await client.call("secrets.set", { key: secret, value: null });
          return 0;
        }
        if (process.stdin.isTTY) return fail(`pipe the value in, e.g.: pbpaste | cmd settings secret ${secret}`);
        let value = "";
        for await (const chunk of process.stdin) value += chunk;
        if (!value.trim()) return fail("no value on stdin (use --clear to remove it)");
        await client.call("secrets.set", { key: secret, value: value.trim() });
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
        const unit = def.type === "number" && def.unit ? ` (${def.unit})` : "";
        console.log(`${mark} ${k.padEnd(28)} ${JSON.stringify(snap.settings[k]).padEnd(24)} ${def.description}${unit}${applies}`);
      }
      const secrets = await client.call("secrets.status", {});
      for (const [k, def] of Object.entries(SECRETS) as [SecretKey, SecretDef][]) {
        const st = secrets[k];
        console.log(`${st.set ? "*" : " "} ${k.padEnd(28)} ${(st.set ? `set ${st.hint ?? ""}`.trim() : "not set").padEnd(24)} ${def.description}`);
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
    const { context } = await conn.client.call("hook.ingest", { paneId, agent: kind, event, payload });
    conn.close();
    // Claude, Codex and Gemini all read extra context from this shape.
    if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) + "\n");
  } catch {
    // core not running: ignore
  }
  clearTimeout(timer);
  return 0;
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

async function space(client: Connection["client"]): Promise<number> {
  const [sub = "ls", ...rest] = pos;
  const label = (s: Space) => `${s.home ? "home    " : short(s.id)}  ${s.name.padEnd(20)} ${tilde(s.root)}${s.closedAt ? "  (closed)" : ""}`;
  switch (sub) {
    case "ls": {
      const spaces = await client.call("space.list", { closed: !!opt.all });
      if (opt.json) return out(spaces);
      for (const s of spaces) console.log(label(s));
      return 0;
    }
    case "open": {
      const target = rest[0] ?? ".";
      const { space, created } = await client.call("space.open", {
        path: target,
        cwd: process.cwd(),
        gitRoot: !!opt["git-root"],
        show: true,
        newWindow: !!opt["new-window"],
      });
      if (opt.json) return out({ space, created });
      return out(`${created ? "new Space" : "Space"} ${space.name}  ${tilde(space.root)}`);
    }
    case "which": {
      const s = await client.call("space.match", { path: rest[0] ?? ".", cwd: process.cwd() });
      return out(opt.json ? s : label(s));
    }
    case "close":
    case "forget": {
      const s = await findSpace(client, rest[0]);
      await client.call(sub === "close" ? "space.close" : "space.forget", { id: s.id });
      return out(`${sub === "close" ? "closed" : "forgot"} ${s.name}`);
    }
    case "rename": {
      // `rename NAME` renames this terminal's Space; `rename SPACE NAME` another one.
      const [a, b] = rest;
      if (!a) return fail("usage: cmd space rename [SPACE] NAME");
      const s = await findSpace(client, b === undefined ? undefined : a);
      const next = await client.call("space.update", { id: s.id, name: b ?? a });
      return out(`renamed to ${next.name}`);
    }
    case "icon": {
      // `icon SYMBOL` sets this terminal's Space's icon; `icon SPACE SYMBOL` another's; `-` resets it.
      const [a, b] = rest;
      if (!a) return fail("usage: cmd space icon [SPACE] SYMBOL");
      const s = await findSpace(client, b === undefined ? undefined : a);
      const symbol = b ?? a;
      const next = await client.call("space.update", { id: s.id, icon: symbol === "-" ? null : symbol });
      return out(`${next.name}: ${next.icon ?? "default icon"}`);
    }
    default:
      return fail(`unknown space command: ${sub}\n\n${HELP}`);
  }
}

async function remote(client: Connection["client"]): Promise<number> {
  const [sub = "status", ...rest] = pos;
  const scopeArg = (v: unknown): RemoteScope | undefined => (v === "view" || v === "control" ? v : undefined);
  const find = async (prefix: string | undefined) => {
    const ds = (await client.call("remote.devices", {})).filter((d) => prefix && (d.id.startsWith(prefix) || d.name.toLowerCase().startsWith(prefix.toLowerCase())));
    if (ds.length !== 1) throw new Error(ds.length ? `ambiguous device: ${prefix}` : `no such device: ${prefix ?? "(none given)"}`);
    return ds[0]!;
  };
  switch (sub) {
    case "status":
    case "on":
    case "off": {
      const before = sub === "off" ? (await client.call("remote.status", {})).sessions.length : 0;
      const st = await client.call(sub === "on" ? "remote.enable" : sub === "off" ? "remote.disable" : "remote.status", {});
      if (opt.json) return out(st);
      printRemote(st, await client.call("window.list", {}));
      if (sub === "off" && before) console.log(`\nclosed ${before} session${before === 1 ? "" : "s"}`);
      if (sub === "on" && st.state !== "error" && !st.devices.length) console.log("\nnext: cmd remote pair");
      return 0;
    }
    case "devices": {
      const ds = await client.call("remote.devices", {});
      if (opt.json) return out(ds);
      if (!ds.length) return out("no paired devices (cmd remote pair)");
      for (const d of ds) console.log(remoteDevice(d));
      return 0;
    }
    case "log": {
      const log = await client.call("remote.log", { limit: Number(opt.limit ?? 30) });
      if (opt.json) return out(log);
      for (const e of log.reverse()) console.log(`${new Date(e.at).toLocaleString().padEnd(22)} ${e.kind.padEnd(16)} ${(e.device ?? (e.deviceId ? short(e.deviceId) : "")).padEnd(20)} ${e.detail ?? ""}`);
      return 0;
    }
    case "revoke": {
      const d = await find(rest[0]);
      await client.call("remote.revoke", { id: d.id });
      return out(`unpaired ${d.name}`);
    }
    case "disconnect": {
      const d = rest[0] ? await find(rest[0]) : null;
      await client.call("remote.disconnect", { id: d?.id });
      return out(d ? `disconnected ${d.name} (still paired)` : "disconnected every device (still paired)");
    }
    case "scope": {
      const scope = scopeArg(rest[1]);
      if (!scope) return fail("usage: cmd remote scope <device> view|control");
      const d = await client.call("remote.setScope", { id: (await find(rest[0])).id, scope });
      return out(`${d.name}: ${d.scope === "view" ? "view only" : "control"}`);
    }
    case "pair":
      return remotePair(client, scopeArg(opt.scope) ?? "view");
    default:
      return fail(`unknown remote command: ${sub}\n\n${HELP}`);
  }
}

/** Show a one-time link as a QR code, then approve the device here (works with the app closed, or over SSH). */
async function remotePair(client: Connection["client"], scope: RemoteScope): Promise<number> {
  const requests: RemotePairRequest[] = [];
  let wake = () => {};
  client.onEvent((e) => {
    if (e.type === "remote.pairRequest") requests.push(e.request), wake();
  });
  await client.call("events.subscribe", { types: ["remote.pairRequest"] });
  const { url, expiresAt } = await client.call("remote.pair", { scope });
  if (opt.json) console.log(JSON.stringify({ url, expiresAt }));
  else {
    if (process.stdout.isTTY) console.log(renderUnicodeCompact(url, { ecc: "L", border: 2 }));
    console.log(`Scan with your phone's camera, or open:\n${url}\n\nWorks once, for 5 minutes. Waiting for a device… (Ctrl-C to cancel)`);
  }
  while (Date.now() < expiresAt) {
    const req = requests.shift();
    if (!req) {
      await new Promise<void>((r) => ((wake = r), setTimeout(r, 1000)));
      continue;
    }
    console.log(`\n“${req.name}” wants to use cmd on this Mac.\nCheck that its screen shows:  ${req.words.join(" ")}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Allow? [v]iew only, [c]ontrol (a shell on this Mac), [n]o: ")).trim().toLowerCase();
    rl.close();
    const chosen: RemoteScope | null = answer.startsWith("c") ? "control" : answer.startsWith("v") ? "view" : null;
    await client.call("remote.approve", { requestId: req.requestId, allow: !!chosen, scope: chosen ?? undefined });
    return out(chosen ? `paired ${req.name} (${chosen === "view" ? "view only" : "control"})` : "not allowed");
  }
  return fail("the pairing link expired (cmd remote pair for a new one)");
}

const REMOTE_STATE: Record<RemoteStatus["state"], string> = { off: "off", connecting: "connecting…", online: "ready", error: "can't connect" };

function printRemote(st: RemoteStatus, windows: AppWindow[]): void {
  const title = (id: string) => windows.find((w) => w.id === id)?.title ?? short(id);
  console.log(`Remote access: ${REMOTE_STATE[st.state]}${st.error ? ` (${st.error})` : ""}${st.relay ? `  ·  relay ${st.relay}` : ""}`);
  if (st.sessions.length) {
    console.log("\nConnected now");
    for (const s of st.sessions) {
      const watching = s.watching.length ? `watching ${s.watching.map(title).join(", ")}` : "on its home screen";
      console.log(`  ${s.name.padEnd(24)} ${(s.scope === "view" ? "view only" : "control").padEnd(10)} since ${new Date(s.since).toLocaleTimeString()}  ${watching}  (${s.ip})`);
    }
  }
  console.log(st.devices.length ? "\nPaired devices" : "\nNo paired devices (cmd remote pair)");
  for (const d of st.devices) console.log(`  ${remoteDevice(d)}`);
}

function remoteDevice(d: RemoteDevice): string {
  const seen = d.connected ? "connected" : `last seen ${ago(d.lastSeenAt)}`;
  return `${short(d.id)}  ${d.name.padEnd(24)} ${(d.scope === "view" ? "view only" : "control").padEnd(10)} ${seen}`;
}

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

/** A Space by id prefix, name or folder; none given: this terminal's. */
async function findSpace(client: Connection["client"], ref: string | undefined): Promise<Space> {
  const spaces = await client.call("space.list", { closed: true });
  if (ref === undefined) {
    if (!callerPaneId) throw new Error("not inside cmd: name the Space (id, name or folder)");
    const me = await client.call("identify", { paneId: callerPaneId });
    const s = spaces.find((x) => x.id === me.pane?.spaceId);
    if (!s) throw new Error("this terminal's Space is gone");
    return s;
  }
  const hits = spaces.filter((s) => s.id.startsWith(ref) || s.name === ref);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new Error(`ambiguous Space: ${ref}`);
  // A folder: the Space rooted exactly there (open or closed).
  try {
    const root = fs.realpathSync.native(path.resolve(ref.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")));
    const s = spaces.find((x) => x.root === root);
    if (s) return s;
  } catch {}
  throw new Error(`no such Space: ${ref}`);
}

const tilde = (p: string) => (process.env.HOME && (p === process.env.HOME || p.startsWith(process.env.HOME + "/")) ? "~" + p.slice(process.env.HOME.length) : p);

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

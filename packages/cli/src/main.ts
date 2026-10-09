// `cmd`: the CLI over the core socket. Used by humans, hooks and host agents.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Agent, AgentState, GitPlace, Pane, Workspace } from "@cmd/protocol";
import { APPLIES_LABEL, placeAgainst, currentKey, currentSecretKey, ENV, isSecretKey, SECRETS, type SecretDef, type SecretKey, SETTINGS_SCHEMA, isSettingKey, parseSettingValue, type SettingDef, type SettingKey } from "@cmd/protocol";
import { connect, defaultSocketPath, type Connection } from "@cmd/protocol/node";
import { magicCommand } from "./magic.ts";
import { widgetCommand } from "./widget.ts";
import { AGENTS_HELP, agentsCommand, pickAgent } from "./agents.ts";
import { JOURNAL_HELP, journalCommand } from "./journal.ts";
import { DATA_HELP, dataCommand } from "./data.ts";
import { REMOTE_HELP, remoteCommand } from "./remote.ts";

const HELP = `cmd — terminal + agent workbench

usage: cmd <command> [options]

  . | <dir> [-n] [--git-root]         open the folder as a workspace (or return to it);
                                      -n: in a new app window, --git-root: the repository's root
  workspace [ls] [--all] [--json]         open workspaces (--all: recent ones too)
  workspace which [PATH]                  the workspace a path belongs to
  workspace close|rename|forget [WORKSPACE] [NAME]
  workspace icon [WORKSPACE] SYMBOL           its icon: an SF Symbol name (- for the default)
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
${JOURNAL_HELP}
${DATA_HELP}
  open <path|url> [--kind K] [--types] open in a cmd window (folder, text, browser, …);
                                      --types lists window types
  actions [PATH] [--all] [--json]     how to run the project here: its scripts, make targets, …
                                      (Workspace Actions; --all: hidden ones and history too)
  actions run NAME [PATH] [--restart] run one in a terminal of the folder's workspace
  search <query…> [--json] [--limit N]  search past agent sessions
  resume <session-id> [--agent claude|codex|…] [--fork]
  magic <request…> [--help]          build a widget (or a terminal command) from a request
                                      (runs here, no core needed; see cmd magic --help)
  widget list | add <widget>          the Widget Library; put a widget in a workspace
  widget new|check|run|preview [dir]  make and check Magic widget folders (cmd widget --help)
  settings [get KEY | set KEY VALUE | reset KEY | path] [--json]
                                      list or change settings (applies live)
  settings secret KEY [--clear]       store an API key from stdin (pbpaste | cmd settings secret
                                      ai.anthropic.apiKey); never in settings.json
${REMOTE_HELP}

env: ${ENV.socket} (default ${defaultSocketPath()})`;

const COMMANDS = new Set(["ls", "identify", "new", "spawn", "send", "read", "wait", "kill", "notify", "events", "hook", "hooks", "agents", "journal", "data", "open", "actions", "search", "resume", "settings", "workspace", "remote", "help"]);

/**
 * `cmd .`, `cmd ~/src/x`, `cmd ../y`: a folder to open as a workspace. A command name
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

// Before 0.24 workspaces were Spaces: `cmd space …` and `--space` still work.
const rawArgv = process.argv.slice(2).map((a, i) => (i === 0 && a === "space" ? "workspace" : a === "--space" ? "--workspace" : a.startsWith("--space=") ? `--workspace=${a.slice(8)}` : a));
const argv = isFolderArg(rawArgv[0]) ? ["workspace", "open", ...rawArgv] : rawArgv;
const cmd = argv[0];
/** The terminal this runs in, if inside cmd: new things go to its workspace. */
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
    weeks: { type: "string" },
    view: { type: "string" },
    // cmd data
    before: { type: "string" },
    rules: { type: "boolean" },
    type: { type: "string" },
    since: { type: "string" },
    project: { type: "string" },
    session: { type: "string" },
    text: { type: "string" },
    rescan: { type: "boolean" },
    anonymize: { type: "boolean" },
    out: { type: "string" },
    open: { type: "boolean" },
    workspace: { type: "string" },
    repo: { type: "string" },
    day: { type: "string" },
    write: { type: "boolean" },
    "no-write": { type: "boolean" },
    restart: { type: "boolean" },
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
      const [panes, agents, workspaces] = await Promise.all([client.call("pane.list", {}), client.call("agent.list", {}), client.call("workspace.list", {})]);
      if (opt.json) return out({ panes, agents });
      printTree(panes, agents, new Map(workspaces.map((s) => [s.id, s])));
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
      const label = { installed: "installed", missing: "not installed", legacy: "older hook", elsewhere: "another cmd's hook", stale: "broken cmd hook (script gone)" };
      for (const t of targets) console.log(`${t.title.padEnd(12)} ${label[t.state].padEnd(14)} ${t.file}${t.declined ? "  (removed by you: not added automatically)" : ""}`);
      if (targets.some((t) => t.agent === "codex" && t.state === "installed")) console.log("\nCodex runs a new hook only once you approve it: run /hooks in Codex.");
      return 0;
    }
    case "agents":
      return agentsCommand(client, closed, pos, opt);
    case "journal":
      return journalCommand(client, pos, opt, callerPaneId);
    case "data":
      return dataCommand(client, pos, opt);
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
      // One argument is a command line as typed ("pnpm dev | tee log"); several are words, each quoted.
      const words = dash >= 0 ? argv.slice(dash + 1) : [];
      const command = !words.length ? undefined : words.length === 1 ? words[0] : words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
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
    case "workspace":
      return workspace(client);
    case "remote":
      return remoteCommand(client, pos, opt);
    case "actions": {
      const running = pos[0] === "run";
      const args = pos[0] === "run" || pos[0] === "ls" ? pos.slice(1) : pos;
      const name = running ? args[0] : undefined;
      if (running && !name) return fail("usage: cmd actions run NAME [PATH]");
      const dir = path.resolve(str(running ? args[1] : args[0]) ?? process.cwd());
      const list = await client.call("actions.list", { path: dir });
      if (running) {
        const all = [...list.actions, ...list.history, ...list.suggested];
        // An id, else a name: the root's before a package's.
        const hits = all.filter((a) => a.id === name).length ? all.filter((a) => a.id === name) : all.filter((a) => a.name === name);
        const a = hits.find((h) => !h.package) ?? (hits.length === 1 ? hits[0] : undefined);
        if (!a) return fail(hits.length ? `"${name}" is in several packages: ${hits.map((h) => h.id).join(", ")}` : `no action "${name}" in ${tilde(dir)} (cmd actions ${tilde(dir)} lists them)`);
        const r = await client.call("actions.run", { root: list.root, actionId: a.id, restart: !!opt.restart });
        if (opt.json) return out({ ...r, action: a });
        console.log(r.started ? `${a.command}  (pane ${r.paneId})` : `already running in pane ${r.paneId} (--restart to run it again)`);
        return 0;
      }
      if (opt.json) return out(list);
      // The root's, then each package's, in the core's order within each.
      const packages = [undefined, ...new Set(list.actions.map((a) => a.package).filter(Boolean))];
      const shown = list.actions.filter((a) => opt.all || !a.hidden).sort((a, b) => packages.indexOf(a.package) - packages.indexOf(b.package));
      const runs = new Map(list.runs.map((r) => [r.actionId, r]));
      const w = Math.min(28, Math.max(4, ...shown.map((a) => a.name.length)));
      let pkg: string | undefined = "\0";
      for (const a of shown) {
        if (a.package !== pkg) {
          pkg = a.package;
          console.log(`\n${a.package ?? tilde(list.root)}`);
        }
        const r = runs.get(a.id);
        const state = r ? (r.endedAt === null ? ` ● running${r.url ? ` ${r.url}` : ""}` : r.exitCode === 0 ? " ✓" : r.exitCode !== null ? ` ✕ ${r.exitCode}` : "") : "";
        const flags = `${a.long ? "∞" : " "}${a.risky ? "!" : " "}${a.pinned ? "★" : " "}`;
        console.log(`  ${flags} ${a.name.padEnd(w)}  ${a.command.padEnd(Math.min(36, a.command.length + 2))}${a.description ? `  ${a.description}` : ""}${state}`);
      }
      if (opt.all && list.history.length) {
        console.log("\nfrom your history");
        for (const h of list.history) console.log(`      ${h.command}  (${h.history?.runs ?? 0}×)`);
      }
      if (list.suggested.length) {
        console.log("\nsuggested from the docs");
        for (const s of list.suggested) console.log(`      ${s.command}${s.description ? `  ${s.description}` : ""}`);
      }
      const away = list.elsewhere.filter((r) => r.endedAt === null);
      if (away.length) {
        console.log("\nrunning in other worktrees");
        for (const r of away) console.log(`      ${list.actions.find((a) => a.id === r.actionId)?.name ?? r.actionId}  in ${r.branch ?? tilde(r.root)} (${tilde(r.root)})${r.url ? `  ${r.url}` : ""}`);
      }
      for (const e of list.sources.filter((x) => x.error)) console.error(`\n${e.file} can't be read: ${e.error}`);
      if (!shown.length) console.log(`no scripts found in ${tilde(list.root)}`);
      return 0;
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
        const where = [h.cwd ? tilde(h.cwd) : null, h.branch].filter(Boolean).join(" · ");
        console.log(`${h.sessionId.slice(0, 8)}  ${h.agent.padEnd(6)} ${when}  ${h.title.slice(0, 70)}${where ? `  (${where})` : ""}`);
        if (h.snippet) console.log(`          ${h.snippet.replace(/\x01/g, process.stdout.isTTY ? "\x1b[1m" : "").replace(/\x02/g, process.stdout.isTTY ? "\x1b[0m" : "").slice(0, 160)}`);
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


async function resolveAgent(client: Connection["client"], ref: string): Promise<string> {
  const [agents, panes] = await Promise.all([client.call("agent.list", {}), client.call("pane.list", {})]);
  const a = pickAgent(agents, panes, ref);
  if (!a) throw new Error(`no such agent: ${ref}`);
  return a.id;
}

async function resolvePane(client: Connection["client"], prefix: string): Promise<string> {
  const [panes, agents] = await Promise.all([client.call("pane.list", {}), client.call("agent.list", {})]);
  const pane = panes.find((p) => p.id.startsWith(prefix));
  if (pane) return pane.id;
  const agent = pickAgent(agents, panes, prefix);
  if (agent?.paneId) return agent.paneId;
  throw new Error(`no such pane or agent: ${prefix}`);
}

async function workspace(client: Connection["client"]): Promise<number> {
  const [sub = "ls", ...rest] = pos;
  const label = (s: Workspace) => `${s.home ? "home    " : short(s.id)}  ${s.name.padEnd(20)} ${tilde(s.root)}${s.closedAt ? "  (closed)" : ""}`;
  switch (sub) {
    case "ls": {
      const workspaces = await client.call("workspace.list", { closed: !!opt.all });
      if (opt.json) return out(workspaces);
      for (const s of workspaces) console.log(label(s));
      return 0;
    }
    case "open": {
      const target = rest[0] ?? ".";
      const { workspace, created } = await client.call("workspace.open", {
        path: target,
        cwd: process.cwd(),
        gitRoot: !!opt["git-root"],
        show: true,
        newWindow: !!opt["new-window"],
      });
      if (opt.json) return out({ workspace, created });
      return out(`${created ? "new workspace" : "workspace"} ${workspace.name}  ${tilde(workspace.root)}`);
    }
    case "which": {
      const s = await client.call("workspace.match", { path: rest[0] ?? ".", cwd: process.cwd() });
      return out(opt.json ? s : label(s));
    }
    case "close":
    case "forget": {
      const s = await findWorkspace(client, rest[0]);
      await client.call(sub === "close" ? "workspace.close" : "workspace.forget", { id: s.id });
      return out(`${sub === "close" ? "closed" : "forgot"} ${s.name}`);
    }
    case "rename": {
      // `rename NAME` renames this terminal's workspace; `rename SPACE NAME` another one.
      const [a, b] = rest;
      if (!a) return fail("usage: cmd workspace rename [WORKSPACE] NAME");
      const s = await findWorkspace(client, b === undefined ? undefined : a);
      const next = await client.call("workspace.update", { id: s.id, name: b ?? a });
      return out(`renamed to ${next.name}`);
    }
    case "icon": {
      // `icon SYMBOL` sets this terminal's workspace's icon; `icon SPACE SYMBOL` another's; `-` resets it.
      const [a, b] = rest;
      if (!a) return fail("usage: cmd workspace icon [WORKSPACE] SYMBOL");
      const s = await findWorkspace(client, b === undefined ? undefined : a);
      const symbol = b ?? a;
      const next = await client.call("workspace.update", { id: s.id, icon: symbol === "-" ? null : symbol });
      return out(`${next.name}: ${next.icon ?? "default icon"}`);
    }
    default:
      return fail(`unknown workspace command: ${sub}\n\n${HELP}`);
  }
}

/** A workspace by id prefix, name or folder; none given: this terminal's. */
async function findWorkspace(client: Connection["client"], ref: string | undefined): Promise<Workspace> {
  const workspaces = await client.call("workspace.list", { closed: true });
  if (ref === undefined) {
    if (!callerPaneId) throw new Error("not inside cmd: name the workspace (id, name or folder)");
    const me = await client.call("identify", { paneId: callerPaneId });
    const s = workspaces.find((x) => x.id === me.pane?.workspaceId);
    if (!s) throw new Error("this terminal's workspace is gone");
    return s;
  }
  const hits = workspaces.filter((s) => s.id.startsWith(ref) || s.name === ref);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new Error(`ambiguous workspace: ${ref}`);
  // A folder: the workspace rooted exactly there (open or closed).
  try {
    const root = fs.realpathSync.native(path.resolve(ref.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")));
    const s = workspaces.find((x) => x.root === root);
    if (s) return s;
  } catch {}
  throw new Error(`no such workspace: ${ref}`);
}

const tilde = (p: string) => (process.env.HOME && (p === process.env.HOME || p.startsWith(process.env.HOME + "/")) ? "~" + p.slice(process.env.HOME.length) : p);

/** Where an agent or terminal is, where that differs from its workspace (docs/35): "on <branch>" for a worktree of its project, "in <project>" elsewhere. */
function whereText(git: GitPlace | null | undefined, cwd: string, workspace: Workspace | undefined): string {
  const at = placeAgainst(git, cwd, workspace);
  if (!at) return "";
  if ("folder" in at) return `  in ${tilde(at.folder)}`;
  const branch = at.git.linked && at.git.branch ? ` on ${at.git.branch}` : "";
  return at.sameProject && branch ? `  ${branch.trim()}` : `  in ${tilde(at.git.top)}${branch}`;
}

function printTree(panes: Pane[], agents: Agent[], workspaces: Map<string, Workspace>): void {
  const byParent = new Map<string | null, Agent[]>();
  for (const a of agents) byParent.set(a.parentId, [...(byParent.get(a.parentId) ?? []), a]);
  const line = (a: Agent, indent: string) => {
    const name = a.name ? ` ${a.name}` : "";
    const where = a.depth === 0 ? whereText(a.git, a.cwd, workspaces.get(a.workspaceId)) : "";
    const detail = a.detail ? `  — ${a.detail}` : "";
    console.log(`${indent}${short(a.id)} ${a.kind}${name} [${a.state}]${a.paneId ? ` pane ${short(a.paneId)}` : " (virtual)"}${where}${detail}`);
    for (const c of byParent.get(a.id) ?? []) line(c, indent + "  ");
  };
  const roots = agents.filter((a) => !a.parentId || !agents.some((p) => p.id === a.parentId));
  for (const r of roots) line(r, "");
  for (const p of panes) if (!p.agentId) console.log(`${short(p.id)} ${p.foreground} — ${p.title}${whereText(p.git, p.cwd, workspaces.get(p.workspaceId)) || `  ${tilde(p.cwd)}`}`);
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

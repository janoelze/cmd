// Reads cmd's Discord server (crash reports, feature ideas) through a read-only bot,
// for agents to triage. REST only, no gateway: it polls when asked.
//   node scripts/discord.mjs channels                     every channel the bot can see: id, type, name
//   node scripts/discord.mjs read <channel> [options]     messages, newest last; threads and forum posts inlined
//     --since 7d|12h|2026-10-01   default 7d
//     --limit N                   at most N top-level messages or forum posts (default 200)
//     --save <dir>                download attachments there (crash logs); otherwise their URLs are printed
//     --json                      one JSON document instead of text
// <channel> is an id or a name (without #). The token comes from $CMD_DISCORD_TOKEN,
// else ~/src/.secrets/cmd-discord-token, else ~/.config/cmd-discord/token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API = "https://discord.com/api/v10";
const TEXT = 0, ANNOUNCEMENT = 5, FORUM = 15, MEDIA = 16;
const KIND = { 0: "text", 2: "voice", 4: "category", 5: "announcement", 13: "stage", 15: "forum", 16: "media" };

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

function token() {
  if (process.env.CMD_DISCORD_TOKEN) return process.env.CMD_DISCORD_TOKEN.trim();
  for (const f of ["src/.secrets/cmd-discord-token", ".config/cmd-discord/token"]) {
    const p = path.join(os.homedir(), f);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  fail("No Discord token: set CMD_DISCORD_TOKEN or write it to ~/src/.secrets/cmd-discord-token");
}

const auth = `Bot ${token()}`;

async function api(route, query = {}) {
  const url = new URL(API + route);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  for (;;) {
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000)));
      continue;
    }
    if (res.status === 403) throw Object.assign(new Error(`no access to ${route}`), { forbidden: true });
    if (!res.ok) throw new Error(`${res.status} on ${route}: ${await res.text()}`);
    return res.json();
  }
}

// Snowflakes carry their creation time.
const snowflakeTime = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

function parseSince(s) {
  const m = /^(\d+)([hdw])$/.exec(s);
  if (m) return Date.now() - Number(m[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]];
  const t = Date.parse(s);
  return Number.isNaN(t) ? fail(`--since: expected 7d, 12h, 2w or a date, got ${s}`) : t;
}

async function channels() {
  const guilds = await api("/users/@me/guilds");
  if (!guilds.length) fail("The bot is in no server yet. Invite it with the bot scope, View Channels and Read Message History.");
  const out = [];
  for (const g of guilds) {
    const list = await api(`/guilds/${g.id}/channels`);
    const cats = new Map(list.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
    for (const c of list) {
      if (c.type === 4) continue;
      out.push({ guild: g.name, guildId: g.id, id: c.id, name: c.name, kind: KIND[c.type] ?? String(c.type), type: c.type, category: cats.get(c.parent_id) ?? null });
    }
  }
  return out;
}

// Messages of a channel or thread since `since`, oldest first.
async function messages(channelId, since, limit = Infinity) {
  const all = [];
  let before;
  while (all.length < limit) {
    const page = await api(`/channels/${channelId}/messages`, { limit: 100, before });
    for (const m of page) {
      if (snowflakeTime(m.id) < since || all.length >= limit) return all.reverse();
      all.push(m);
    }
    if (page.length < 100) break;
    before = page.at(-1).id;
  }
  return all.reverse();
}

// Forum posts (threads) under a forum channel, active and archived, created since `since`.
async function forumThreads(ch, since, limit) {
  const active = (await api(`/guilds/${ch.guildId}/threads/active`)).threads.filter((t) => t.parent_id === ch.id);
  const archived = [];
  let before;
  for (;;) {
    const page = await api(`/channels/${ch.id}/threads/archived/public`, { limit: 100, before });
    archived.push(...page.threads);
    const last = page.threads.at(-1);
    if (!page.has_more || !last || Date.parse(last.thread_metadata.archive_timestamp) < since) break;
    before = last.thread_metadata.archive_timestamp;
  }
  const seen = new Set();
  return [...active, ...archived]
    .filter((t) => !seen.has(t.id) && seen.add(t.id))
    .filter((t) => snowflakeTime(t.id) >= since)
    .sort((a, b) => snowflakeTime(a.id) - snowflakeTime(b.id))
    .slice(-limit);
}

function slim(m) {
  return {
    id: m.id,
    at: new Date(snowflakeTime(m.id)).toISOString(),
    author: m.author?.global_name || m.author?.username,
    text: m.content,
    attachments: (m.attachments ?? []).map((a) => ({ name: a.filename, size: a.size, url: a.url })),
    embeds: (m.embeds ?? []).map((e) => [e.title, e.description].filter(Boolean).join("\n")).filter(Boolean),
  };
}

async function save(dir, posts) {
  fs.mkdirSync(dir, { recursive: true });
  for (const m of posts.flatMap((p) => [p, ...(p.replies ?? [])])) {
    for (const a of m.attachments) {
      const file = path.join(dir, `${m.id}-${a.name.replace(/[^\w.-]/g, "_")}`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(await (await fetch(a.url)).arrayBuffer()));
      a.file = file;
    }
  }
}

async function read(name, opts) {
  const all = await channels();
  const ch = all.find((c) => c.id === name) ?? all.find((c) => c.name === name.replace(/^#/, ""));
  if (!ch) fail(`No channel ${name}. The bot sees: ${all.map((c) => c.name).join(", ")}`);
  const since = parseSince(opts.since ?? "7d");
  const limit = Number(opts.limit ?? 200);
  let posts;
  if (ch.type === FORUM || ch.type === MEDIA) {
    const tags = new Map(((await api(`/channels/${ch.id}`)).available_tags ?? []).map((t) => [t.id, t.name]));
    posts = [];
    for (const t of await forumThreads(ch, since, limit)) {
      const [first, ...replies] = await messages(t.id, 0);
      posts.push({ ...(first ? slim(first) : { id: t.id, at: new Date(snowflakeTime(t.id)).toISOString(), text: "", attachments: [], embeds: [] }), title: t.name, tags: (t.applied_tags ?? []).map((id) => tags.get(id) ?? id), replies: replies.map(slim) });
    }
  } else if (ch.type === TEXT || ch.type === ANNOUNCEMENT) {
    posts = [];
    for (const m of await messages(ch.id, since, limit)) {
      const p = slim(m);
      if (m.thread) p.replies = (await messages(m.thread.id, 0)).map(slim).filter((r) => r.id !== m.id);
      posts.push(p);
    }
  } else fail(`#${ch.name} is a ${ch.kind} channel; only text, announcement and forum channels have messages to read`);
  if (opts.save) await save(opts.save, posts);
  return { channel: ch, since: new Date(since).toISOString(), posts };
}

function printText({ channel, since, posts }) {
  console.log(`#${channel.name} (${channel.kind}), ${posts.length} since ${since.slice(0, 10)}\n`);
  const line = (m, indent) => {
    const pad = " ".repeat(indent);
    console.log(`${pad}[${m.at.slice(0, 16).replace("T", " ")}] ${m.author ?? "?"}:`);
    for (const l of [m.text, ...m.embeds].filter(Boolean).join("\n").split("\n")) console.log(`${pad}  ${l}`);
    for (const a of m.attachments) console.log(`${pad}  📎 ${a.name} (${a.size} B) ${a.file ?? a.url}`);
  };
  for (const p of posts) {
    if (p.title) console.log(`## ${p.title}${p.tags?.length ? `  [${p.tags.join(", ")}]` : ""}`);
    line(p, 0);
    for (const r of p.replies ?? []) line(r, 4);
    console.log();
  }
}

const args = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--json") opts.json = true;
  else if (args[i].startsWith("--")) opts[args[i].slice(2)] = args[++i];
  else pos.push(args[i]);
}

const [cmd, target] = pos;
try {
  if (cmd === "channels") {
    const list = await channels();
    if (opts.json) console.log(JSON.stringify(list, null, 2));
    else for (const c of list) console.log(`${c.id}  ${c.kind.padEnd(12)} ${c.category ? `${c.category} / ` : ""}#${c.name}`);
  } else if (cmd === "read" && target) {
    const result = await read(target, opts);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printText(result);
  } else {
    fail("usage: pnpm discord channels | pnpm discord read <channel> [--since 7d] [--limit N] [--save dir] [--json]");
  }
} catch (e) {
  fail(e.forbidden ? `${e.message}. Give the bot View Channels and Read Message History on that channel (private channels need it added explicitly).` : e.message);
}

// Reads cmd's Discord server (crash reports, feature ideas) for agents to triage, and
// keeps the triage state on the messages themselves, so every session sees what was
// reviewed: the bot's reaction is the state, a reply in the message's thread the note.
// REST only, no gateway: it polls when asked. The routine: .claude/skills/triage/SKILL.md.
//   node scripts/discord.mjs channels                     every channel the bot can see: id, type, name
//   node scripts/discord.mjs read <channel> [options]     messages, newest last; threads and forum posts inlined
//     --since 7d|12h|2026-10-01   default 7d
//     --limit N                   at most N top-level messages or forum posts (default 200)
//     --save <dir>                download attachments there (crash logs); otherwise their URLs are printed
//     --json                      one JSON document instead of text
//   node scripts/discord.mjs inbox [--channel c] [--since 90d] [--all] [--json]
//                                                         untriaged and in-progress messages of #crashes and
//                                                         #feedback, grouped by signature; attachments saved
//   node scripts/discord.mjs mark <state> <ref>... [--note "…"]
//                                                         state: wip 👀, done ✅, dup 🔁, wontfix 🚫, open (clears);
//                                                         ref: <channel>/<message id> as inbox prints it
// <channel> is an id or a name (without #). The token comes from $CMD_DISCORD_TOKEN,
// else ~/src/.secrets/cmd-discord-token, else ~/.config/cmd-discord/token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API = "https://discord.com/api/v10";
const TEXT = 0, ANNOUNCEMENT = 5, FORUM = 15, MEDIA = 16;
const STATES = { wip: "👀", done: "✅", dup: "🔁", wontfix: "🚫" };
const TRIAGE = ["crashes", "feedback"];
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

async function api(route, query = {}, method = "GET", body) {
  const url = new URL(API + route);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  const headers = { Authorization: auth, ...(body && { "Content-Type": "application/json" }) };
  for (;;) {
    const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000)));
      continue;
    }
    if (res.status === 403) throw Object.assign(new Error(`no access to ${route}`), { forbidden: true });
    if (!res.ok) throw new Error(`${res.status} on ${method} ${route}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
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
      if (m.type === 0 || m.type === 19) all.push(m); // not "started a thread" (18), thread starters (21) and other system messages
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

// The triage state: the first of the bot's own reactions that is one of STATES.
function stateOf(m) {
  const mine = new Set((m.reactions ?? []).filter((r) => r.me).map((r) => r.emoji.name));
  return Object.keys(STATES).find((k) => mine.has(STATES[k])) ?? null;
}

function findChannel(all, name) {
  const ch = all.find((c) => c.id === name) ?? all.find((c) => c.name === name.replace(/^#/, ""));
  return ch ?? fail(`No channel ${name}. The bot sees: ${all.map((c) => c.name).join(", ")}`);
}

async function read(name, opts, all) {
  const ch = findChannel(all ?? (await channels()), name);
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
      const p = { ...slim(m), state: stateOf(m) };
      if (m.thread) p.replies = (await messages(m.thread.id, 0)).map(slim).filter((r) => r.id !== m.id);
      posts.push(p);
    }
  } else fail(`#${ch.name} is a ${ch.kind} channel; only text, announcement and forum channels have messages to read`);
  // Without the Message Content intent Discord blanks content, embeds and attachments alike.
  const blank = (m) => !m.text && !m.embeds.length && !m.attachments.length;
  if (posts.length && posts.every(blank)) console.error("Every message came back blank: turn on Message Content Intent (Developer Portal → Bot).\n");
  if (opts.save) await save(opts.save, posts);
  return { channel: ch, since: new Date(since).toISOString(), posts };
}

// One line that says what a message is about: code blocks dropped, embed title and text joined.
const summary = (p) => [p.text, ...p.embeds].join("\n").replace(/```[\s\S]*?```/g, "").split("\n").map((l) => l.trim()).filter(Boolean).join(" · ");
// Reports of the same problem differ only in ids, hashes and numbers.
const signature = (p) => summary(p).toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").replace(/\b[0-9a-f]{8,}\b/g, "<hex>").replace(/\d+/g, "N");

async function inbox(opts) {
  const all = await channels();
  const out = [];
  for (const name of opts.channel ? [opts.channel] : TRIAGE) {
    const save = path.join(os.tmpdir(), "cmd-discord", name);
    const { channel, posts } = await read(name, { since: opts.since ?? "90d", limit: opts.limit ?? 1000, save }, all);
    const groups = new Map();
    for (const p of posts) {
      if (!opts.all && p.state && p.state !== "wip") continue;
      const key = signature(p);
      if (!groups.has(key)) groups.set(key, { summary: summary(p) || "(empty)", reports: [] });
      groups.get(key).reports.push({ ref: `${channel.name}/${p.id}`, ...p });
    }
    out.push({ channel: channel.name, groups: [...groups.values()] });
  }
  return out;
}

function printInbox(channels) {
  for (const { channel, groups } of channels) {
    const n = groups.reduce((a, g) => a + g.reports.length, 0);
    console.log(`#${channel}: ${groups.length ? `${groups.length} open (${n} message${n === 1 ? "" : "s"})` : "nothing open"}\n`);
    for (const g of groups) {
      const r = g.reports;
      const days = [...new Set([r[0].at.slice(0, 10), r.at(-1).at.slice(0, 10)])].join(" → ");
      console.log(`## ${g.summary}${r.length > 1 ? `  ×${r.length}` : ""}  (${days})`);
      for (const m of r) {
        console.log(`   ${m.state ? STATES[m.state] : "  "} ${m.ref}  ${m.at.slice(0, 16).replace("T", " ")}`);
        for (const a of m.attachments) console.log(`        📎 ${a.file ?? a.url}`);
        for (const reply of m.replies ?? []) console.log(`        ↳ ${reply.author}: ${reply.text.split("\n").join(" ")}`);
      }
      console.log();
    }
  }
}

async function mark(state, refs, note) {
  if (state !== "open" && !STATES[state]) fail(`state: one of ${Object.keys(STATES).join(", ")}, open`);
  if (!refs.length) fail("mark: which messages? Pass <channel>/<message id> as inbox prints them");
  const all = await channels();
  for (const ref of refs) {
    const [name, id] = ref.split("/");
    if (!id) fail(`${ref}: expected <channel>/<message id>`);
    const ch = findChannel(all, name);
    const route = `/channels/${ch.id}/messages/${id}`;
    const m = await api(route);
    for (const [k, emoji] of Object.entries(STATES)) {
      const mine = (m.reactions ?? []).some((r) => r.me && r.emoji.name === emoji);
      if (k === state && !mine) await api(`${route}/reactions/${encodeURIComponent(emoji)}/@me`, {}, "PUT");
      if (k !== state && mine) await api(`${route}/reactions/${encodeURIComponent(emoji)}/@me`, {}, "DELETE");
    }
    if (note) {
      const name = summary(slim(m)).slice(0, 90) || "triage";
      const thread = m.thread?.id ?? (await api(`${route}/threads`, {}, "POST", { name })).id;
      await api(`/channels/${thread}/messages`, {}, "POST", { content: `${STATES[state] ?? "↩️"} ${note}` });
    }
    console.log(`${ref}: ${state}${note ? " (noted in its thread)" : ""}`);
  }
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
  if (args[i] === "--json" || args[i] === "--all") opts[args[i].slice(2)] = true;
  else if (args[i].startsWith("--")) opts[args[i].slice(2)] = args[++i];
  else pos.push(args[i]);
}

const [cmd, target, ...rest] = pos;
try {
  if (cmd === "channels") {
    const list = await channels();
    if (opts.json) console.log(JSON.stringify(list, null, 2));
    else for (const c of list) console.log(`${c.id}  ${c.kind.padEnd(12)} ${c.category ? `${c.category} / ` : ""}#${c.name}`);
  } else if (cmd === "read" && target) {
    const result = await read(target, opts);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printText(result);
  } else if (cmd === "inbox") {
    const result = await inbox(opts);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printInbox(result);
  } else if (cmd === "mark" && target) {
    await mark(target, rest, opts.note);
  } else {
    fail("usage: pnpm discord channels | read <channel> [--since 7d] [--limit N] [--save dir] [--json] | inbox [--channel c] [--since 90d] [--all] [--json] | mark <wip|done|dup|wontfix|open> <ref>... [--note …]");
  }
} catch (e) {
  fail(e.forbidden ? `${e.message}. Give the bot View Channels and Read Message History on that channel (private channels need it added explicitly).` : e.message);
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTurn, JournalEvent, Workspace } from "@cmd/protocol";
import type { SessionRow } from "../src/data/views/sessions.ts";
import { Core } from "../src/core.ts";
import { digest, eventsHash } from "../src/journal/digest.ts";
import { gitEvents, gitStamp, parseReflog } from "../src/journal/git.ts";
import { JournalService, SYNC_FRESH_MS, type JournalAi } from "../src/journal/service.ts";
import { DatabaseSync } from "node:sqlite";
import { JOURNAL_SCHEMA, SOURCES_FORMAT, WRITER_FORMAT, type JournalDay } from "@cmd/protocol";
import { JournalStore, UPGRADES, type NewJournalEvent } from "../src/journal/store.ts";
import { buildThreads } from "../src/journal/threads.ts";
import { toDay, type WrittenDay } from "../src/journal/writer.ts";
import { fakeFactory } from "./fake-pty.ts";
import { syntheticDay } from "./fixtures/journal-day.ts";
import { rmTemp } from "./tmp.ts";

const DAY = "2026-10-07";
const from = new Date(`${DAY}T04:00:00`).getTime();
const to = from + 86400_000;

function fixture(): { store: JournalStore; events: JournalEvent[] } {
  const store = new JournalStore();
  store.recordAll(syntheticDay(DAY));
  return { store, events: store.events() };
}

const note = (at: number, key: string, o: Partial<NewJournalEvent> = {}): NewJournalEvent => ({
  at,
  until: null,
  kind: "note",
  key,
  workspaceId: null,
  repo: null,
  cwd: null,
  thread: null,
  text: "n",
  data: { kind: "note", by: "user", agentSession: null },
  ...o,
});

describe("journal store", () => {
  it("updates an event seen again in the log: the span grows, the newest text wins", () => {
    const s = new JournalStore();
    const id = s.record({ ...note(100, "k"), until: 200 });
    expect(s.record({ ...note(150, "k"), until: 400, text: "newer" })).toBe(id);
    s.record({ ...note(120, "k"), until: 300 });
    const [e] = s.events();
    expect(e).toMatchObject({ id, at: 100, until: 400, text: "n", kind: "note" });
    expect(s.data.query({ types: ["note"] })).toHaveLength(1);
  });

  it("keeps derived kinds seeded for fixtures apart from the log", () => {
    const s = new JournalStore();
    s.recordAll(syntheticDay(DAY));
    const kinds = new Set(s.events().map((e) => e.kind));
    expect(kinds.has("agent.turn") && kinds.has("agent.session") && kinds.has("git.commit")).toBe(true);
    expect(s.data.query({ types: ["agent."] })).toHaveLength(0);
    expect(s.data.query({ types: ["git."] }).length).toBeGreaterThan(0);
  });

  it("finds spans that reach into the range", () => {
    const s = new JournalStore();
    s.recordAll([{ ...note(100, "a"), until: 1000 }, note(500, "b"), note(2000, "c")]);
    expect(s.events({ since: 400, until: 1500 }).map((e) => e.key)).toEqual(["a", "b"]);
  });
});

describe("journal git", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(rmTemp));

  it("parses reflog lines", () => {
    const line = `${"0".repeat(40)} ${"a".repeat(40)} Sam <s@x> 1791280074 +0200\tcommit (initial): First`;
    expect(parseReflog(`${line}\nnot a line\n`)).toEqual([{ old: "0".repeat(40), new: "a".repeat(40), at: 1791280074000, message: "commit (initial): First" }]);
  });

  it("reads a branch built in a worktree, merged, tagged and deleted", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-journal-")));
    dirs.push(root);
    const repo = path.join(root, "app");
    const wt = path.join(root, "app-feat");
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@x", ...a], { stdio: "pipe" });
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "Start");
    git(repo, "worktree", "add", "-q", wt, "-b", "feat");
    git(wt, "commit", "-q", "--allow-empty", "-m", "Feature: the thing");
    git(repo, "merge", "-q", "--ff-only", "feat");
    git(repo, "worktree", "remove", wt);
    git(repo, "branch", "-q", "-d", "feat");
    git(repo, "commit", "-q", "--allow-empty", "-m", "Release v1.0.0");
    git(repo, "tag", "v1.0.0");

    const ev = await gitEvents(wt.replace("app-feat", "app"));
    const commit = ev.find((e) => e.data.kind === "git.commit" && e.data.subject === "Feature: the thing");
    expect(commit?.data).toMatchObject({ branch: "feat" });
    expect(commit?.thread).toBe(`branch:${repo}#feat`);
    expect(ev.find((e) => e.kind === "git.merge")?.data).toMatchObject({ branch: "feat", into: "main", fastForward: true });
    expect(ev.find((e) => e.kind === "git.tag")).toMatchObject({ thread: `release:${repo}#v1.0.0`, repo });
    // Reading twice gives the same keys.
    expect((await gitEvents(repo)).map((e) => e.key).sort()).toEqual(ev.map((e) => e.key).sort());
  });

  it("stamps a repository so a sync can tell nothing changed", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-journal-")));
    dirs.push(root);
    const repo = path.join(root, "app");
    const wt = path.join(root, "app-feat");
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@x", ...a], { stdio: "pipe" });
    fs.mkdirSync(repo);
    expect(await gitStamp(repo)).toBeNull();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "Start");
    const stamps = [await gitStamp(repo)];
    expect(await gitStamp(repo)).toBe(stamps[0]);
    fs.writeFileSync(path.join(repo, "a.txt"), "edited, not committed");
    expect(await gitStamp(repo)).toBe(stamps[0]);
    git(repo, "worktree", "add", "-q", wt, "-b", "feat");
    stamps.push(await gitStamp(wt));
    git(wt, "commit", "-q", "--allow-empty", "-m", "In the worktree");
    stamps.push(await gitStamp(repo));
    git(repo, "tag", "v1");
    stamps.push(await gitStamp(repo));
    git(repo, "pack-refs", "--all");
    stamps.push(await gitStamp(repo));
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});

describe("journal threads", () => {
  it("joins a session with the branch it built, and a release with the session that cut it", () => {
    const { events } = fixture();
    const threads = buildThreads(events, { from, to });
    const byId = new Map(threads.map((t) => [t.id, t]));
    const fts = byId.get("session:s-fts")!;
    expect(fts.links).toContainEqual({ to: "branch:/Users/sam/src/shopfront#fts-rebuild", rule: "edited 3 files in ~/src/shopfront-fts-rebuild" });
    expect(byId.get("branch:/Users/sam/src/shopfront#fts-rebuild")!.group).toBe(fts.group);
    const release = byId.get("release:/Users/sam/src/shopfront#v2.3.0")!;
    expect(release.links.map((l) => l.rule)).toEqual(["shipped in v2.3.0", "shipped in v2.3.0"]);
    expect(release.group).toBe(byId.get("session:s-rel")!.group);
    // Shipping doesn't make the release part of the work it shipped.
    expect(release.group).not.toBe(fts.group);
  });

  it("links terminals and pages busy during one session as hints, not into its group", () => {
    const threads = buildThreads(fixture().events, { from, to });
    const pages = threads.find((t) => t.kind === "browsing" && t.label === "SQLite FTS5 Extension")!;
    expect(pages.links).toEqual([{ to: "session:s-fts", rule: "read while that session worked" }]);
    expect(pages.group).toBe(pages.id);
  });

  it("calls noise minor", () => {
    const threads = buildThreads(fixture().events, { from, to });
    const minor = threads.filter((t) => t.minor).map((t) => t.id);
    expect(minor).toEqual(expect.arrayContaining(["session:s-hi", "session:s-weather"]));
    expect(minor.some((id) => id.startsWith("browsing:w3"))).toBe(true);
    expect(minor).not.toContain("session:s-flaky");
  });

  it("is deterministic", () => {
    const { events } = fixture();
    const a = buildThreads(events, { from, to });
    const b = buildThreads([...events].reverse(), { from, to });
    expect(b).toEqual(a);
    expect(digest(b, events, { title: "t" }).hash).toBe(digest(a, events, { title: "t" }).hash);
  });
});

describe("journal writer", () => {
  it("keeps what the model wrote and adds what it left out", () => {
    const { events } = fixture();
    const threads = buildThreads(events, { from, to });
    const d = digest(threads, events, { title: "t" });
    const ref = (id: string) => [...d.refs].find(([, t]) => t === id)![0];
    const w: WrittenDay = {
      headline: "Fixed search.",
      entries: [{ refs: [ref("session:s-fts"), ref("branch:/Users/sam/src/shopfront#fts-rebuild"), "Z9"], kind: "fix", title: "Fixed search index corruption.", summary: "It rebuilds.", outcome: "merged" }],
    };
    const day = toDay(w, d, threads, events, { date: from, scope: "all", writtenBy: "m" });
    const fts = day.entries.find((e) => e.id === "session:s-fts")!;
    expect(fts).toMatchObject({ kind: "fix", title: "Fixed search index corruption", outcome: "merged" });
    expect(fts.counts).toMatchObject({ agents: 1, prompts: 5, commits: 2 });
    // The release the model skipped: an entry from the data.
    expect(day.entries.find((e) => e.threads.includes("release:/Users/sam/src/shopfront#v2.3.0"))).toMatchObject({ kind: "release", title: "Released v2.3.0", summary: "Shipped Checkout btn, Fts rebuild." });
    // Every thread that isn't minor is in an entry.
    const covered = new Set(day.entries.flatMap((e) => e.threads));
    expect(threads.filter((t) => !t.minor && !covered.has(t.id))).toEqual([]);
  });
});

describe("journal service", () => {
  const workspace: Workspace = { id: "shop", name: "Shopfront", root: "/Users/sam/src/shopfront", home: false, icon: null, order: 0, closedAt: null, createdAt: 0, lastActiveAt: 0, view: {} } as unknown as Workspace;

  function service(ai: JournalAi | null, now = to + 3 * 86400_000) {
    const store = new JournalStore();
    store.recordAll(syntheticDay(DAY));
    return new JournalService({ store, workspaces: () => [workspace], agentWorkspace: () => null, ai, now: () => now });
  }

  it("writes a day once, until its events change", async () => {
    let calls = 0;
    const ai: JournalAi = {
      modelName: () => "Model",
      object: async <T,>() => (calls++, { value: { headline: "A day.", entries: [] } as T, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "m" }),
    };
    const j = service(ai, to + 3600_000); // yesterday: a past day older than that is final once written (below)
    const date = j.dayOf(from + 3600_000);
    expect((await j.day("all", date))?.headline).toBe("A day.");
    await j.day("all", date);
    expect(calls).toBe(1);
    j.store.record(note(from + 7200_000, "late", { text: "one more thing" }));
    await j.day("all", date);
    expect(calls).toBe(2);
    await j.day("all", date, "force");
    expect(calls).toBe(3);
  });

  it("writes no day without a model", async () => {
    expect(await service(null).day("workspace:shop", new Date(DAY).setHours(0, 0, 0, 0))).toBeNull();
  });

  it("keeps a workspace to its own projects", async () => {
    let prompt = "";
    const ai: JournalAi = { modelName: () => "Model", object: async <T,>(o: { prompt: string }) => ((prompt = o.prompt), { value: { headline: "", entries: [] } as T, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "m" }) };
    await service(ai).day("workspace:shop", new Date(DAY).setHours(0, 0, 0, 0));
    expect(prompt).toContain("v2.3.0");
    expect(prompt).not.toContain("dotfiles");
  });

  it("reads several days from one query as it would one by one", () => {
    const j = service(null);
    const date = j.dayOf(from + 3600_000);
    const pool = j.store.events({ since: from - 30 * 86400_000, limit: Number.MAX_SAFE_INTEGER });
    for (const d of [date, date - 86400_000, date + 86400_000])
      for (const scope of ["all", "workspace:shop"]) {
        const one = j.threads(scope, d);
        const pooled = j.threads(scope, d, pool);
        expect(pooled.events).toEqual(one.events);
        expect(pooled.digest.hash).toBe(one.digest.hash);
      }
  });

  it("reads git at most once a minute for the widget, and skips repositories that didn't change", async () => {
    let now = 100 * 86400_000;
    const read: string[] = [];
    const stamps: Record<string, string> = { [workspace.root]: "a" };
    const j = new JournalService({ store: new JournalStore(), workspaces: () => [workspace], agentWorkspace: () => null, ai: null, now: () => now, git: async (repo) => (read.push(repo), []), gitStamp: async (repo) => stamps[repo] ?? null });
    await j.sync();
    expect(read).toHaveLength(1);
    await j.sync(SYNC_FRESH_MS);
    expect(read).toHaveLength(1); // fresh enough: not synced at all
    await j.sync();
    expect(read).toHaveLength(1); // synced, but nothing changed
    now += SYNC_FRESH_MS;
    stamps[workspace.root] = "b";
    await j.sync(SYNC_FRESH_MS);
    expect(read).toHaveLength(2);
  });

  it("notes from an agent's terminal join its session", async () => {
    const core = new Core({ socketPath: path.join(os.tmpdir(), `cmd-j-${process.pid}.sock`), dbPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    try {
      const { id } = await core.call("journal.note", { text: "Cause found: batches outside a transaction" });
      const [e] = await core.call("journal.events", { kinds: ["note"] });
      expect(e).toMatchObject({ id, text: "Cause found: batches outside a transaction", data: { by: "user" } });
    } finally {
      await core.close();
    }
  });
});

describe("journal days a session spans", () => {
  // Three work days, Monday to Wednesday; "now" is Wednesday, so Monday is older than yesterday.
  const day = (n: number, h: number, m = 0) => new Date(2026, 9, 5 + n, h, m).getTime();
  const turn = (index: number, start: number, prompt: string): { turn: AgentTurn; cwd: string | null } => ({
    turn: { agentId: "a1", agentKind: "claude", sessionId: "s1", index, startedAt: start, endedAt: start + 10 * 60_000, prompt, auto: false, followUps: [], final: "Done.", outcome: "done", error: null, files: [{ path: "/w/shop/src/a.ts" }], commands: [], tools: [] } as unknown as AgentTurn,
    cwd: "/w/shop",
  });

  function setup() {
    const turns = [turn(0, day(0, 10), "Build the checkout flow"), turn(1, day(1, 10), "Add tests for the checkout flow"), turn(2, day(2, 10), "Fix the checkout totals")];
    const session = { key: "claude:s1", id: "s1", agent: "claude", path: null, env: null, cwd: "/w/shop", branch: null, title: "Checkout", first_prompt: "Build the checkout flow", started: day(0, 10), updated: day(2, 10, 10), messages: 6, project_id: null, name: null, name_by: null, named_at: null } as SessionRow;
    const store = new JournalStore(null, { turns: (since) => turns.filter((t) => (t.turn.endedAt ?? t.turn.startedAt) >= since), sessions: (since) => [session].filter((r) => (r.updated ?? 0) >= since) });
    let now = day(2, 12);
    const written: string[] = [];
    const ai: JournalAi = { modelName: () => "Model", object: async <T,>() => (written.push(new Date(now).toDateString()), { value: { headline: "A day.", entries: [] } as T, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "m" }) };
    const j = new JournalService({ store, workspaces: () => [], agentWorkspace: () => null, ai, now: () => now, git: async () => [] });
    return { j, store, turns, session, written, at: (t: number) => (now = t), dates: [0, 1, 2].map((n) => j.dayOf(day(n, 12))) };
  }

  async function writeAll(j: JournalService, dates: number[], mode: "stale" | "force" = "stale") {
    const out = [];
    for (const d of dates) out.push(await j.day("all", d, mode));
    return out;
  }

  it("leaves finished days alone when the session gets a new turn today", async () => {
    const { j, turns, session, written, at, dates } = setup();
    const first = await writeAll(j, dates);
    expect(written).toHaveLength(3);
    at(day(2, 12, 45)); // past today's throttle
    turns.push(turn(3, day(2, 12, 20), "Round the totals per line"));
    session.updated = day(2, 12, 30);
    const second = await writeAll(j, dates);
    expect(written).toHaveLength(4); // today only
    expect(second[0]!.writtenAt).toBe(first[0]!.writtenAt);
    expect(second[1]!.writtenAt).toBe(first[1]!.writtenAt);
    expect(second[2]!.writtenAt).toBe(day(2, 12, 45));
  });

  it("doesn't write a day older than yesterday again when the session is renamed", async () => {
    const { j, session, written, at, dates } = setup();
    const first = await writeAll(j, dates);
    at(day(2, 12, 45));
    Object.assign(session, { title: "Checkout, renamed", name: "checkout", name_by: "user", named_at: day(2, 12, 40) });
    const second = await writeAll(j, dates);
    expect(written).toHaveLength(3);
    expect(second.map((d) => d!.writtenAt)).toEqual(first.map((d) => d!.writtenAt));
  });

  it("writes a day older than yesterday again only when asked, unless it was written before it ended", async () => {
    const { j, store, written, at, dates } = setup();
    const first = await writeAll(j, dates);
    at(day(2, 12, 45));
    // Something recorded late into Monday (a commit read from git after the fact).
    store.record({ at: day(0, 16), until: null, kind: "note", key: "late", workspaceId: null, repo: null, cwd: null, thread: null, text: "Found it", data: { kind: "note", by: "user", agentSession: null } });
    expect((await j.day("all", dates[0]!))?.writtenAt).toBe(first[0]!.writtenAt);
    expect(written).toHaveLength(3);
    expect((await j.day("all", dates[0]!, "force"))?.writtenAt).toBe(day(2, 12, 45));
    expect(written).toHaveLength(4);
    // Monday written on Monday afternoon: still open, so what came after is written in.
    store.saveDay({ ...store.day("all", dates[0]!)!, writtenAt: day(0, 15) });
    store.record({ at: day(0, 18), until: null, kind: "note", key: "later", workspaceId: null, repo: null, cwd: null, thread: null, text: "And this", data: { kind: "note", by: "user", agentSession: null } });
    await j.day("all", dates[0]!);
    expect(written).toHaveLength(5);
  });

  it("hashes what the day contains: spans clipped to its window, without a session's title", () => {
    const { j, session, dates } = setup();
    const hash = (date: number) => {
      const t = j.threads("all", date);
      return eventsHash(t.threads, t.events, { from: t.from, to: t.to });
    };
    const before = dates.map(hash);
    session.updated = day(2, 20);
    session.title = "Something else";
    expect(dates.slice(0, 2).map(hash)).toEqual(before.slice(0, 2));
    expect(hash(dates[2]!)).not.toBe(before[2]); // today's part of the span grew
  });
});

describe("journal versions", () => {
  const workspace: Workspace = { id: "shop", name: "Shopfront", root: "/Users/sam/src/shopfront" } as unknown as Workspace;
  const written = (headline: string) => ({ value: { headline, entries: [] }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "m" });

  function service(store: JournalStore, now: number, onWrite: () => void) {
    const ai: JournalAi = { modelName: () => "Model", object: async <T,>() => (onWrite(), written("New rules.") as unknown as { value: T; usage: { input: number; output: number; cacheRead: number; cacheWrite: number }; model: string }) };
    return new JournalService({ store, workspaces: () => [workspace], agentWorkspace: () => null, ai, now: () => now });
  }

  it("records the days' schema, and which cmd wrote each event", () => {
    const db = new DatabaseSync(":memory:");
    const s = new JournalStore(db, { recordedBy: "0.15.0" });
    s.record(note(1, "a"));
    expect(s.schemaVersion()).toBe(JOURNAL_SCHEMA);
    expect(s.data.query({ types: ["note"] })[0]).toMatchObject({ recorded: "0.15.0", source: "journal" });
  });

  it("runs the upgrades between an older database's schema and this one", () => {
    const db = new DatabaseSync(":memory:");
    new JournalStore(db);
    db.prepare(`UPDATE schema_versions SET version = ? WHERE name = 'journal'`).run(JOURNAL_SCHEMA - 1);
    const ran: number[] = [];
    const had = UPGRADES[JOURNAL_SCHEMA];
    UPGRADES[JOURNAL_SCHEMA] = () => void ran.push(JOURNAL_SCHEMA);
    try {
      expect(new JournalStore(db).schemaVersion()).toBe(JOURNAL_SCHEMA);
      expect(ran).toEqual([JOURNAL_SCHEMA]);
      new JournalStore(db);
      expect(ran).toEqual([JOURNAL_SCHEMA]); // once
    } finally {
      if (had) UPGRADES[JOURNAL_SCHEMA] = had;
      else delete UPGRADES[JOURNAL_SCHEMA];
    }
  });

  it("skips events it can't read instead of failing the day", () => {
    const s = new JournalStore();
    s.recordAll([note(1, "ok"), note(2, "bad"), note(3, "other")]);
    s.data.store.db.prepare(`UPDATE events SET data = jsonb('null') WHERE id = 'bad'`).run();
    s.data.store.db.prepare(`UPDATE events SET type = 'future.kind' WHERE id = 'other'`).run();
    expect(s.events().map((e) => e.key)).toEqual(["ok"]);
  });

  it("reads days written before they carried their format, and keeps the ones it replaces", () => {
    const db = new DatabaseSync(":memory:");
    const s = new JournalStore(db);
    const old = { date: 1, scope: "all", headline: "v1", entries: [], writtenBy: "m", writtenAt: 1, inputHash: "x", minor: 0 };
    db.prepare(`INSERT INTO journal_days (scope, date, doc) VALUES ('all', 1, ?)`).run(JSON.stringify(old));
    expect(s.day("all", 1)).toMatchObject({ headline: "v1", format: { schema: 1, threads: 1, writer: 1 }, eventsHash: "" });
    for (const h of ["v2", "v3", "v4", "v5"]) s.saveDay({ ...s.day("all", 1)!, headline: h, outdated: true });
    expect(s.day("all", 1)?.headline).toBe("v5");
    expect(s.day("all", 1)).not.toHaveProperty("outdated");
    expect(s.history("all", 1).map((d) => d.headline)).toEqual(["v4", "v3", "v2"]);
  });

  /** The fixture's day, stored as written by an older writer. */
  function olderDay(store: JournalStore, now: number): { date: number; j: JournalService; calls: () => number } {
    let n = 0;
    const j = service(store, now, () => n++);
    const date = j.dayOf(from + 3600_000);
    const t = j.threads("all", date);
    const day: JournalDay = { date, scope: "all", headline: "Old rules.", entries: [], writtenBy: "m", writtenAt: now - 86400_000, format: { schema: JOURNAL_SCHEMA, threads: 1, writer: WRITER_FORMAT - 1 }, eventsHash: "", inputHash: t.digest.hash, minor: 0 };
    store.saveDay(day);
    return { date, j, calls: () => n };
  }

  it("keeps a past day written by older rules as it was, marked outdated", async () => {
    const { store } = fixture();
    const { date, j, calls } = olderDay(store, to + 5 * 86400_000);
    expect(await j.day("all", date)).toMatchObject({ headline: "Old rules.", outdated: true });
    expect(calls()).toBe(0);
    expect(await j.day("all", date, "force")).toMatchObject({ headline: "New rules.", format: { writer: WRITER_FORMAT } });
    expect(calls()).toBe(1);
    expect(store.history("all", date)[0]?.headline).toBe("Old rules.");
  });

  it("writes a recent day again when older rules wrote it", async () => {
    const { store } = fixture();
    const { date, j, calls } = olderDay(store, to - 3600_000);
    expect((await j.day("all", date))?.headline).toBe("New rules.");
    expect(calls()).toBe(1);
  });

  it("reads git again when the sources format changed, then only what's new", async () => {
    const store = new JournalStore();
    const asked: number[] = [];
    const make = () => new JournalService({ store, workspaces: () => [workspace], agentWorkspace: () => null, ai: null, now: () => 100 * 86400_000, git: async (_repo, since) => (asked.push(since), []) });
    await make().sync();
    expect(asked[0]).toBe(10 * 86400_000); // 90 days back
    expect(store.meta("sources.format")).toBe(String(SOURCES_FORMAT));
    await make().sync();
    expect(asked[1]).toBe(100 * 86400_000 - 2 * 3600_000); // from the last read, kept across restarts
    store.setMeta("sources.format", String(SOURCES_FORMAT - 1));
    await make().sync();
    expect(asked[2]).toBe(10 * 86400_000);
  });
});

describe("journal weeks", () => {
  const workspace: Workspace = { id: "shop", name: "Shopfront", root: "/Users/sam/src/shopfront", home: false, icon: null, order: 0, closedAt: null, createdAt: 0, lastActiveAt: 0, view: {} } as unknown as Workspace;
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

  it("rolls a week up from its days, keeps it until a day changes, and gathers what the model left out", async () => {
    const calls: string[] = [];
    const ai: JournalAi = {
      modelName: () => "Model",
      object: async <T,>(o: { purpose: string; prompt: string }) => {
        calls.push(o.purpose);
        if (o.purpose === "journal.week") {
          expect(o.prompt).toMatch(/\[E1\]/);
          return { value: { headline: "A week.", themes: [{ title: "Checkout work.", summary: "Fixed the cart.", entries: ["E1", "E99"] }] } as T, usage, model: "m" };
        }
        return { value: { headline: "A day.", entries: [{ refs: ["S1"], kind: "fix", title: "Cart fix", summary: "Fixed.", outcome: "fixed" }] } as T, usage, model: "m" };
      },
    };
    const store = new JournalStore();
    store.recordAll(syntheticDay(DAY));
    const now = to + 3 * 86400_000;
    const j = new JournalService({ store, workspaces: () => [workspace], agentWorkspace: () => null, ai, now: () => now });
    const w = (await j.week("all", from + 3600_000))!;
    expect(w.headline).toBe("A week.");
    expect(w.themes[0]).toMatchObject({ title: "Checkout work", entries: [{ day: j.dayOf(from + 3600_000) }] }); // E99 dropped
    expect(w.themes.at(-1)!.title).toBe("Also"); // the day's other entries (fallbacks) the model didn't place
    expect(w.days).toEqual([j.dayOf(from + 3600_000)]);
    const weekCalls = () => calls.filter((c) => c === "journal.week").length;
    await j.week("all", from + 3600_000);
    expect(weekCalls()).toBe(1); // the same days: kept
    await j.week("all", from + 3600_000, "force");
    expect(weekCalls()).toBe(2);
    expect(await j.week("all", from + 3600_000, "never")).toMatchObject({ headline: "A week." });
  });
});

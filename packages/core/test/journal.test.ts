import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JournalEvent, Space } from "@cmd/protocol";
import { Core } from "../src/core.ts";
import { digest } from "../src/journal/digest.ts";
import { gitEvents, parseReflog } from "../src/journal/git.ts";
import { JournalService, type JournalAi } from "../src/journal/service.ts";
import { JournalStore, type NewJournalEvent } from "../src/journal/store.ts";
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
  spaceId: null,
  repo: null,
  cwd: null,
  thread: null,
  text: "n",
  data: { kind: "note", by: "user", agentSession: null },
  ...o,
});

describe("journal store", () => {
  it("updates an event seen again: the span grows, live wins over backfill", () => {
    const s = new JournalStore();
    const id = s.record({ ...note(100, "k"), until: 200, source: "backfill" });
    expect(s.record({ ...note(150, "k"), until: 400, text: "newer", source: "live" })).toBe(id);
    s.record({ ...note(120, "k"), until: 300, source: "backfill" });
    const [e] = s.events();
    expect(e).toMatchObject({ id, at: 100, until: 400, text: "n", source: "live" });
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
  const space: Space = { id: "shop", name: "Shopfront", root: "/Users/sam/src/shopfront", home: false, icon: null, order: 0, closedAt: null, createdAt: 0, lastActiveAt: 0, view: {} } as unknown as Space;

  function service(ai: JournalAi | null) {
    const store = new JournalStore();
    store.recordAll(syntheticDay(DAY));
    return new JournalService({ store, activityDb: null, sessions: () => [], spaces: () => [space], agentSpace: () => null, ai, now: () => to + 3 * 86400_000 });
  }

  it("writes a day once, until its events change", async () => {
    let calls = 0;
    const ai: JournalAi = {
      modelName: () => "Model",
      object: async <T,>() => (calls++, { value: { headline: "A day.", entries: [] } as T, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "m" }),
    };
    const j = service(ai);
    const date = j.dayOf(from + 3600_000);
    expect((await j.day("all", date))?.headline).toBe("A day.");
    await j.day("all", date);
    expect(calls).toBe(1);
    j.record(note(from + 7200_000, "late", { text: "one more thing" }));
    await j.day("all", date);
    expect(calls).toBe(2);
    await j.day("all", date, "force");
    expect(calls).toBe(3);
  });

  it("writes no day without a model", async () => {
    expect(await service(null).day("space:shop", new Date(DAY).setHours(0, 0, 0, 0))).toBeNull();
  });

  it("keeps a Space to its own projects", async () => {
    let prompt = "";
    const ai: JournalAi = { modelName: () => "Model", object: async <T,>(o: { prompt: string }) => ((prompt = o.prompt), { value: { headline: "", entries: [] } as T, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "m" }) };
    await service(ai).day("space:shop", new Date(DAY).setHours(0, 0, 0, 0));
    expect(prompt).toContain("v2.3.0");
    expect(prompt).not.toContain("dotfiles");
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

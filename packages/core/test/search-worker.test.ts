// The search worker (data/views/search-worker.ts) on a log on disk, and the
// full-text index's rebuild to the kind column (data/fts.ts, DataStore.buildFts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { commandBody } from "../src/commands.ts";
import { DataService } from "../src/data/service.ts";
import { claudeLine, codexLine, docEvents } from "../src/data/sources/transcripts.ts";
import { DataStore, type StoreEvent } from "../src/data/store.ts";
import { SearchView } from "../src/data/views/search.ts";
import { SessionsView } from "../src/data/views/sessions.ts";
import { ViewsStore } from "../src/data/views/views.ts";
import { rmTemp } from "./tmp.ts";

let dirs: string[] = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-search-worker-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmTemp(d);
  dirs = [];
});

const FILE = { agent: null, path: "/x/s.jsonl", env: null };
const big = "lorem ipsum ".repeat(300);

/** One of every kind of event that has words: transcript lines small and big, Codex, a session read whole, commands, pages, hooks, notes. */
function fixture(): StoreEvent[] {
  const claude = (o: Record<string, unknown>) => claudeLine(JSON.stringify({ sessionId: "s", timestamp: "2026-10-06T10:00:00Z", cwd: "/w", ...o }), 1, FILE)!;
  const codex = (o: Record<string, unknown>, n: number) => codexLine(JSON.stringify(o), n, FILE, { sessionId: "c1", cwd: "/r" })!;
  return [
    claude({ type: "user", uuid: "u1", message: { role: "user", content: "make the sidebar collapsible in AgentMonitor" } }),
    claude({ type: "assistant", uuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "Done." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test --filter sidebar" } }] } }),
    claude({ type: "assistant", uuid: "u3", message: { role: "assistant", content: [{ type: "text", text: `A long answer about wireguard. ${big}` }] } }),
    claude({ type: "user", uuid: "u4", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    claude({ type: "ai-title", aiTitle: "Collapsible sidebar" }),
    claude({ type: "summary", uuid: "u5", summary: "Sidebar work", leafUuid: "u3" }),
    codex({ type: "event_msg", payload: { type: "user_message", message: "migrate the postgres schema" } }, 2),
    codex({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["rg", "SchemaMigrator"] }), call_id: "c" } }, 3),
    ...docEvents({ agent: "copilot", id: "d1", cwd: "/c", branch: null, title: "Lint step", prompts: ["add a lint step"], responses: ["Added eslint."], tools: ["npm run lint"], startedAt: 1, updatedAt: 2 } as never, FILE, 1),
    { id: "command:1", at: 5, type: "command", source: "osc", text: "pnpm test", body: commandBody("pnpm test", "FAIL packages/core/test/flaky.test.ts"), data: { command: "pnpm test", exitCode: 1, cwd: "/w" }, content: "FAIL packages/core/test/flaky.test.ts" },
    { id: "visit:1", at: 6, type: "browser.visit", source: "window", text: "Flaky tests in Vitest", body: "Flaky tests in Vitest", data: { url: "https://vitest.dev/flaky", title: "Flaky tests in Vitest" } },
    { id: "file:1", at: 7, type: "file.open", source: "window", text: "/w/flaky.md", data: { path: "/w/flaky.md" } },
    { id: "hook:1", at: 8, type: "agent.hook", source: "hook:claude", sessionId: "claude:s", text: "fix the zebra", body: "fix the zebra module please", data: { name: "UserPromptSubmit", payload: { prompt: "fix the zebra module please" } } },
    { id: "note:1", at: 9, type: "note", source: "journal", text: "remember the sqlite pragma", body: "remember the sqlite pragma", data: {} },
    { id: "notification:1", at: 10, type: "notification", source: "cmd", text: "Build done", body: "All 312 tests passed", data: { title: "Build done", body: "All 312 tests passed" } },
  ];
}

/** Every term the index holds, with the events and columns it's in. */
const words = (s: DataStore) => s.db.prepare(`SELECT term, doc, cnt FROM events_vocab ORDER BY term`).all();

/** A log as cmd before the kind column left it: the index without it, and no fts.version. */
function makeOld(file: string): void {
  const s = new DataStore(file);
  s.db.exec(`DROP TABLE events_vocab; DROP TABLE events_fts; DELETE FROM meta WHERE key = 'fts.version';
    CREATE VIRTUAL TABLE events_fts USING fts5(text, body, content='', contentless_delete=1, detail=full, tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE events_vocab USING fts5vocab(events_fts, 'row');`);
  for (const r of s.db.prepare(`SELECT seq, text FROM events`).all() as { seq: number; text: string | null }[]) if (r.text) s.db.prepare(`INSERT INTO events_fts (rowid, text, body) VALUES (?, ?, '')`).run(r.seq, r.text);
  s.close();
}

describe("full-text index rebuild", () => {
  it("indexes the same words again from the rows, with each event's kind", async () => {
    const file = path.join(tmpDir(), "events.sqlite");
    const fresh = new DataStore(file);
    fresh.recordAll(fixture());
    const recorded = words(fresh);
    fresh.close();
    makeOld(file);
    const s = new DataStore(file);
    expect(s.needsFtsRebuild).toBe(true);
    expect(await s.buildFts()).toBe(s.count({}));
    expect(s.needsFtsRebuild).toBe(false);
    expect(s.db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'events_fts_old%' OR name LIKE 'events_fts_next%'`).all()).toEqual([]); // the old one dropped
    expect(words(s)).toEqual(recorded);
    const kind = (k: string) => (s.db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH ?`).all(`kind : ${k}`) as { rowid: number }[]).length;
    expect([kind("transcript"), kind("history"), kind("agent"), kind("other")]).toEqual([12, 3, 1, 2]);
    // A query's words never match the kind column.
    expect(s.query({ text: "history" })).toEqual([]);
    s.close();
    expect(new DataStore(file).needsFtsRebuild).toBe(false);
  });

  it("serves the old index during the build, takes what's recorded meanwhile, and goes on after a stop", async () => {
    const file = path.join(tmpDir(), "events.sqlite");
    const first = new DataStore(file);
    first.recordAll(fixture());
    first.close();
    makeOld(file);
    const s = new DataStore(file);
    let steps = 0;
    const stop = new Error("stopped");
    // The core stops after the first step (the build size starts at 200: all of it), between steps of a second build new rows arrive.
    await expect(s.buildFts({ pace: { yield: async () => void (steps++ === 0 && (() => { throw stop; })()) } })).rejects.toBe(stop);
    expect(s.query({ text: "postgres" }).length).toBe(1); // still the old index
    s.close();
    const again = new DataStore(file);
    expect(again.needsFtsRebuild).toBe(true);
    again.record({ id: "note:2", at: 11, type: "note", source: "journal", text: "kumquat jam", body: "kumquat jam recipe", data: {} });
    again.record({ id: "command:1", at: 5, type: "command", source: "osc", text: "pnpm test", body: commandBody("pnpm test", "PASS quokka"), data: { command: "pnpm test", exitCode: 0, cwd: "/w" }, content: "PASS quokka" });
    await again.buildFts({
      pace: {
        yield: async () => void again.record({ id: "note:3", at: 12, type: "note", source: "journal", text: "walrus", body: "walrus operator", data: {} }),
      },
    });
    for (const w of ["kumquat", "quokka", "walrus", "postgres", "zebra"]) expect(again.query({ text: w }).length, w).toBe(1);
    expect(again.query({ text: "flaky" }).map((e) => e.type).sort()).toEqual(["browser.visit", "file.open"]); // the command's output changed
    again.close();
  });
});

describe("full-text index rebuild, the old index's drop", () => {
  const old = (s: DataStore) => !!s.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'events_fts_old'`).get();

  it("drops the old index with its rows in a step of its own", async () => {
    const file = path.join(tmpDir(), "events.sqlite");
    const first = new DataStore(file);
    first.recordAll(fixture());
    first.close();
    makeOld(file);
    const s = new DataStore(file);
    expect((s.db.prepare(`SELECT COUNT(*) AS n FROM events_fts`).get() as { n: number }).n).toBeGreaterThan(0);
    // What each step saw: the drop's own step starts with the old index there and ends with it gone.
    const steps: { activity: string; before: boolean; after?: boolean }[] = [];
    await s.buildFts({
      pace: {
        yield: async () => {},
        mark: (activity) => {
          const step: (typeof steps)[number] = { activity, before: old(s) };
          steps.push(step);
          return () => void (step.after = old(s));
        },
      },
    });
    expect(steps.filter((x) => x.activity === "fts drop old index")).toEqual([{ activity: "fts drop old index", before: true, after: false }]);
    expect(steps.every((x) => x.activity === "fts drop old index" || x.activity === "fts rebuild")).toBe(true);
    expect(old(s)).toBe(false);
    expect(s.needsFtsRebuild).toBe(false);
    s.close();
    expect(new DataStore(file).needsFtsRebuild).toBe(false);
  });

  it("finishes the drop on the next start when the core stopped right after the rename", async () => {
    const file = path.join(tmpDir(), "events.sqlite");
    const first = new DataStore(file);
    first.recordAll(fixture());
    first.close();
    makeOld(file);
    const s = new DataStore(file);
    const stop = new Error("stopped");
    await expect(s.buildFts({ pace: { yield: async () => { if (old(s)) throw stop; } } })).rejects.toBe(stop);
    expect(old(s)).toBe(true);
    s.close();
    const again = new DataStore(file);
    expect(again.needsFtsRebuild).toBe(true); // the leftover
    expect(again.query({ text: "postgres" }).length).toBe(1); // the new index serves meanwhile
    expect(await again.buildFts()).toBe(0); // nothing built again, only dropped
    expect(old(again)).toBe(false);
    expect(again.needsFtsRebuild).toBe(false);
    again.close();
    expect(new DataStore(file).needsFtsRebuild).toBe(false);
  });
});

describe("full-text index rebuild, its last moments", () => {
  it("keeps what's recorded after the last page, while the segments merge", async () => {
    const file = path.join(tmpDir(), "events.sqlite");
    const first = new DataStore(file);
    first.recordAll(Array.from({ length: 1000 }, (_, i) => ({ id: `note:${i}`, at: i, type: "note" as const, source: "journal", text: `note ${i}`, body: `note number ${i}`, data: {} })));
    first.close();
    makeOld(file);
    const s = new DataStore(file);
    const cursor = () => Number(s.meta("fts.cursor"));
    const max = () => (s.db.prepare(`SELECT MAX(seq) AS m FROM events`).get() as { m: number }).m;
    let seen = -1;
    let injected = false;
    await s.buildFts({
      pace: {
        // A second yield at the same cursor, all rows read: the page loop is over and the merges run.
        yield: async () => {
          if (!injected && cursor() === max() && seen === cursor()) {
            s.record({ id: "note:late", at: 2000, type: "note", source: "journal", text: "kumquat", body: "kumquat late", data: {} });
            injected = true;
          }
          seen = cursor();
        },
      },
    });
    expect(injected).toBe(true);
    expect(s.query({ text: "kumquat" }).map((e) => e.id)).toEqual(["note:late"]);
    s.close();
  });
});

describe("search worker", () => {
  const open = (o: { restartMs?: number; timeoutMs?: number } = {}) => {
    const dir = tmpDir();
    const data = new DataService({ file: path.join(dir, "events.sqlite"), recordedBy: "test", settings: () => DEFAULT_SETTINGS });
    const views = new ViewsStore(path.join(dir, "views.sqlite"));
    const sessions = new SessionsView(views, data);
    data.store.recordAll(fixture());
    sessions.apply(data.store.query({ types: ["transcript."], limit: 100 }));
    const view = new SearchView(data, sessions, { viewsFile: views.file, ...o });
    return { data, views, view, close: () => (view.close(), data.dispose(), views.close()) };
  };

  it("answers sessions and history from its own thread", async () => {
    const t = open();
    try {
      const hits = await t.view.search("collapsible");
      expect(hits.map((h) => h.sessionId)).toEqual(["s"]);
      expect(hits[0]!.snippet).toContain("\x01");
      expect(t.view.worker).not.toBeNull();
      expect((await t.view.history("flaky")).map((h) => h.kind).sort()).toEqual(["command", "file", "page"]);
      expect(await t.view.history("flaky", { workspaceId: "elsewhere" })).toEqual([]);
      expect(await t.view.search("wiregaurd")).toMatchObject([{ sessionId: "s", fuzzy: true }]);
    } finally {
      t.close();
    }
  });

  it("fails a request when the worker dies, and while it restarts, instead of waiting", async () => {
    const t = open({ restartMs: 200 });
    try {
      await t.view.search("collapsible"); // running
      const asked = t.view.history("flaky");
      await t.view.worker!.terminate();
      await expect(asked).rejects.toThrow(/Search stopped/);
      await expect(t.view.search("collapsible")).rejects.toThrow(/restarting/);
      await new Promise((r) => setTimeout(r, 250));
      expect((await t.view.search("collapsible")).length).toBe(1); // a new worker
    } finally {
      t.close();
    }
  });

  it("fails a request when the worker can't open the log", async () => {
    const t = open();
    try {
      t.view.close();
      await expect(t.view.search("collapsible")).rejects.toThrow(/closed/);
      const broken = new SearchView(t.data, new SessionsView(t.views, t.data), { viewsFile: path.join(tmpDir(), "missing", "views.sqlite") });
      await expect(broken.search("collapsible")).rejects.toThrow(/Search/);
      broken.close();
    } finally {
      t.close();
    }
  });
});

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

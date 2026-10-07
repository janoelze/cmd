import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataStore } from "../src/data/store.ts";
import { claudeLine } from "../src/data/sources/transcripts.ts";
import { FLAG_IMPORTED } from "../src/data/schema.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-data-")), "events.sqlite");

describe("DataStore", () => {
  it("records once per id: a second recording updates the span, text and data, keeps seq and at", () => {
    const s = new DataStore(tmp());
    const a = s.record({ id: "x:1", at: 1000, type: "command", source: "osc", text: "ls", data: { exitCode: null } });
    const b = s.record({ id: "x:1", at: 1000, until: 1500, type: "command", source: "osc", text: "ls -la", data: { exitCode: 0 }, sessionId: "s1" });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.seq).toBe(a.seq);
    const [e] = s.query({ types: ["command"] });
    expect(e).toMatchObject({ seq: a.seq, at: 1000, until: 1500, text: "ls -la", sessionId: "s1" });
    expect(s.query({}).length).toBe(1);
    s.close();
  });

  it("leaves a row it is handed again unchanged alone: no rewrite, no index churn", () => {
    const s = new DataStore(tmp());
    const e = { id: "a", at: 10, until: 20, type: "transcript.message" as const, source: "t", sessionId: "claude:s", text: "the flaky test", body: "the flaky test raced", data: { role: "user", n: 1.5 }, content: "x".repeat(5000) };
    const changes = () => (s.db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
    const hits = () => (s.db.prepare(`SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH 'flaky'`).get() as { n: number }).n;
    expect(s.record(e).inserted).toBe(true);
    const [c0, h0] = [changes(), hits()];
    expect(s.record({ ...e })).toEqual({ seq: 1, inserted: false });
    expect(changes() - c0).toBeLessThanOrEqual(2); // the blob counted and uncounted, nothing else
    expect(hits()).toBe(h0);
    // Something new: the span grows, an identity fills in, the index follows the text.
    expect(s.record({ ...e, until: 30, agentId: "ag" })).toEqual({ seq: 1, inserted: false });
    expect(s.query({})[0]).toMatchObject({ until: 30, agentId: "ag" });
    s.record({ ...e, text: "the steady test", body: "the steady test raced" });
    expect(hits()).toBe(0);
    expect(s.query({ text: "steady" })).toHaveLength(1);
    s.close();
  });

  it("keeps big content as a deduplicated blob and reads it back", () => {
    const s = new DataStore(tmp());
    const big = "line\n".repeat(5000);
    s.record({ id: "a", at: 1, type: "transcript.message", source: "t", data: { chars: big.length }, content: big });
    s.record({ id: "b", at: 2, type: "transcript.message", source: "t", data: { chars: big.length }, content: big });
    const [a, b] = s.query({});
    expect(a!.blob).toBe(b!.blob);
    expect(s.blob(a!.blob!)!.toString()).toBe(big);
    const st = s.stats();
    expect(st.blobs.count).toBe(1);
    expect(st.blobs.stored).toBeLessThan(st.blobs.size / 5);
    s.close();
  });

  it("counts a blob once per row when a row is recorded again, with or without its content", () => {
    const file = tmp();
    const s = new DataStore(file);
    const big = "line\n".repeat(5000);
    const refs = () => (s.db.prepare(`SELECT refs FROM blobs`).all() as { refs: number }[]).map((r) => r.refs);
    s.record({ id: "a", at: 1, type: "transcript.message", source: "t", data: {}, content: big });
    s.record({ id: "a", at: 1, type: "transcript.message", source: "t", data: {}, content: big }); // the archived copy
    expect(refs()).toEqual([1]);
    s.record({ id: "a", at: 1, type: "transcript.message", source: "t", data: {} }); // read again, short enough to stay inline
    expect(refs()).toEqual([1]);
    expect(s.sweepBlobs()).toBe(0);
    expect(s.blob(s.query({})[0]!.blob!)!.toString()).toBe(big);
    // Counts an older build got wrong are counted again, once.
    s.db.exec(`UPDATE blobs SET refs = 7; DELETE FROM meta WHERE key = 'blobs.recounted'`);
    s.close();
    const again = new DataStore(file);
    expect(again.recountBlobs()).toBe(true);
    expect(again.recountBlobs()).toBe(false);
    expect((again.db.prepare(`SELECT refs FROM blobs`).all() as { refs: number }[]).map((r) => r.refs)).toEqual([1]);
    // The sweep finds unreferenced blobs by their index, not by reading every blob.
    expect((again.db.prepare(`EXPLAIN QUERY PLAN DELETE FROM blobs WHERE refs <= 0`).all() as { detail: string }[]).map((r) => r.detail).join()).toContain("blobs_unreferenced");
    again.delete({ seqs: again.query({}).map((e) => e.seq) });
    expect(again.sweepBlobs()).toBe(1);
    again.close();
  });

  it("filters by type prefix, time, identity and full text", () => {
    const s = new DataStore(tmp());
    s.record({ id: "1", at: 10, type: "git.commit", source: "git", projectId: "p", text: "Fix the flaky test", body: "Fix the flaky test\n\nIt raced on startup.", data: {} });
    s.record({ id: "2", at: 20, type: "git.tag", source: "git", projectId: "p", text: "v1.0", data: {} });
    s.record({ id: "3", at: 30, type: "command", source: "osc", projectId: "q", text: "pnpm test", data: {} });
    expect(s.query({ types: ["git."] }).map((e) => e.id)).toEqual(["1", "2"]);
    expect(s.query({ at: [15, 35] }).map((e) => e.id)).toEqual(["2", "3"]);
    expect(s.query({ types: ["git.", "command"], at: [15, 35] }).map((e) => e.id)).toEqual(["2", "3"]);
    expect(s.query({ types: ["git.tag", "command"], at: [0, 25] }).map((e) => e.id)).toEqual(["2"]);
    expect(s.count({ types: ["git."], at: [0, 15] })).toBe(1);
    expect(s.query({ projectId: "q" }).map((e) => e.id)).toEqual(["3"]);
    expect(s.query({ text: "raced" }).map((e) => e.id)).toEqual(["1"]);
    expect(s.query({ text: "test", order: "desc" }).map((e) => e.id)).toEqual(["3", "1"]);
    // History read in later (a transcript): an old time, a new seq.
    s.record({ id: "4", at: 5, type: "transcript.message", source: "t", text: "older", data: {} });
    expect(s.query({ order: "desc", limit: 2 }).map((e) => e.id)).toEqual(["4", "3"]);
    expect(s.query({ by: "time", order: "desc", limit: 2 }).map((e) => e.id)).toEqual(["3", "2"]);
    expect(s.query({ by: "time" }).map((e) => e.id)).toEqual(["4", "1", "2", "3"]);
    s.close();
  });

  it("rebuilds the full-text index from the rows", () => {
    const s = new DataStore(tmp());
    s.record({ id: "1", at: 10, type: "note", source: "cmd", text: "remember the sqlite pragma", data: {} });
    s.db.exec("DROP TABLE events_fts");
    s.buildFts();
    expect(s.query({ text: "pragma" }).length).toBe(1);
    s.close();
  });

  it("turns a Claude transcript line into an event with the agent's ids kept", () => {
    const line = JSON.stringify({ type: "assistant", uuid: "u2", parentUuid: "u1", sessionId: "s", timestamp: "2026-10-06T10:00:00Z", cwd: "/w", message: { role: "assistant", id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "Done.\nMore." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } });
    const e = claudeLine(line, 1, { agent: "claude", path: "/x/s.jsonl", env: null })!;
    expect(e).toMatchObject({ id: "claude:u2", parentId: "claude:u1", sessionId: "claude:s", projectId: "dir:/w", type: "transcript.message", text: "Done.", at: Date.parse("2026-10-06T10:00:00Z") });
    expect((e.data as { blocks: { name?: string }[] }).blocks[1]!.name).toBe("Bash");
    expect(e.content).toBeNull();
    const s = new DataStore(tmp());
    s.record({ ...e, flags: FLAG_IMPORTED });
    expect(s.query({ sessionId: "claude:s" })[0]!.flags & FLAG_IMPORTED).toBe(FLAG_IMPORTED);
    s.close();
  });
});

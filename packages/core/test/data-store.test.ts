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

  it("filters by type prefix, time, identity and full text", () => {
    const s = new DataStore(tmp());
    s.record({ id: "1", at: 10, type: "git.commit", source: "git", projectId: "p", text: "Fix the flaky test", body: "Fix the flaky test\n\nIt raced on startup.", data: {} });
    s.record({ id: "2", at: 20, type: "git.tag", source: "git", projectId: "p", text: "v1.0", data: {} });
    s.record({ id: "3", at: 30, type: "command", source: "osc", projectId: "q", text: "pnpm test", data: {} });
    expect(s.query({ types: ["git."] }).map((e) => e.id)).toEqual(["1", "2"]);
    expect(s.query({ at: [15, 35] }).map((e) => e.id)).toEqual(["2", "3"]);
    expect(s.query({ projectId: "q" }).map((e) => e.id)).toEqual(["3"]);
    expect(s.query({ text: "raced" }).map((e) => e.id)).toEqual(["1"]);
    expect(s.query({ text: "test", order: "desc" }).map((e) => e.id)).toEqual(["3", "1"]);
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
    const e = claudeLine(line, 1, { agent: "claude", path: "/x/s.jsonl" })!;
    expect(e).toMatchObject({ id: "claude:u2", parentId: "claude:u1", sessionId: "claude:s", projectId: "dir:/w", type: "transcript.message", text: "Done.", at: Date.parse("2026-10-06T10:00:00Z") });
    expect((e.data as { blocks: { name?: string }[] }).blocks[1]!.name).toBe("Bash");
    expect(e.content).toBeNull();
    const s = new DataStore(tmp());
    s.record({ ...e, flags: FLAG_IMPORTED });
    expect(s.query({ sessionId: "claude:s" })[0]!.flags & FLAG_IMPORTED).toBe(FLAG_IMPORTED);
    s.close();
  });
});

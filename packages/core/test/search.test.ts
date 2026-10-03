import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanClaudePrompt, parseClaude, parseCodex } from "../src/search/parser.ts";
import { identifierParts, SearchQuery, Vocabulary, words } from "../src/search/query.ts";
import { indexPass, openIndex, Searcher, type TranscriptRoot } from "../src/search/index.ts";
import { resumeCommand } from "../src/agents/tracker.ts";

const jsonl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";

const claudeSession = (id: string, prompt: string, reply: string, extra: unknown[] = []) =>
  jsonl(
    { type: "user", sessionId: id, cwd: "/Users/me/src/cmd", gitBranch: "main", timestamp: "2026-10-01T10:00:00Z",
      message: { role: "user", content: `<system-reminder>ignore me</system-reminder>${prompt}` } },
    { type: "assistant", sessionId: id, timestamp: "2026-10-01T10:01:00Z",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "secret thoughts" },
        { type: "text", text: reply },
        { type: "tool_use", input: { command: "pnpm test", description: "Run the test suite", file_path: "/src/AgentMonitor.swift" } },
      ] } },
    { type: "user", sessionId: id, message: { role: "user", content: [{ type: "tool_result", content: "HUGE OUTPUT tokens" }] } },
    { type: "user", isSidechain: true, sessionId: id, message: { role: "user", content: "subagent noise" } },
    { type: "ai-title", aiTitle: `Title for ${prompt}` },
    ...extra,
  );

describe("transcript parser (port of TranscriptParser.swift)", () => {
  it("keeps prompts, replies and tool inputs; drops tool results, thinking, sidechains and wrappers", () => {
    const doc = parseClaude(claudeSession("s1", "fix the sidebar", "Done, sidebar fixed."), "/p/s1.jsonl", "/c")!;
    expect(doc).toMatchObject({ id: "s1", cwd: "/Users/me/src/cmd", branch: "main", title: "Title for fix the sidebar" });
    expect(doc.prompts).toEqual(["fix the sidebar"]);
    expect(doc.responses).toEqual(["Done, sidebar fixed."]);
    expect(doc.tools[0]).toContain("Run the test suite pnpm test /src/AgentMonitor.swift");
    expect(JSON.stringify(doc)).not.toMatch(/secret thoughts|HUGE OUTPUT|subagent noise|ignore me/);
  });

  it("turns slash-command markup into text and drops caveats", () => {
    expect(cleanClaudePrompt("<command-name>/review</command-name><command-args>pr 12</command-args>")).toBe("/review  pr 12");
    expect(cleanClaudePrompt("Caveat: The messages below were generated…")).toBe("");
  });

  it("prefers Codex events over model input items, takes the id from session_meta", () => {
    const text = jsonl(
      { type: "session_meta", payload: { id: "019a-thread", cwd: "/repo", git: { branch: "feat" } } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<env>ctx</env>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "dup prompt" }] } },
      { type: "event_msg", payload: { type: "user_message", message: "migrate the database" } },
      { type: "event_msg", payload: { type: "agent_message", message: "Migrated." } },
      { type: "response_item", payload: { type: "function_call", arguments: JSON.stringify({ cmd: ["bash", "-lc", "psql -c 'select 1'"] }) } },
    );
    const doc = parseCodex(text, "/x/rollout-2026-10-01T00-00-00-019a-thread.jsonl")!;
    expect(doc).toMatchObject({ id: "019a-thread", cwd: "/repo", branch: "feat", prompts: ["migrate the database"], responses: ["Migrated."] });
    expect(doc.tools).toEqual(["psql -c 'select 1'"]);
  });

  it("falls back to a generic walk when the layout is unknown", () => {
    const doc = parseClaude(jsonl({ weird: { text: "hello future format" } }, { other: { message: "a reply" } }), "/p/f.jsonl", null)!;
    expect(doc.prompts).toEqual(["hello future format"]);
    expect(doc.responses).toEqual(["a reply"]);
  });
});

describe("query", () => {
  it("parses terms, phrases and exclusions into an FTS5 expression", () => {
    const q = new SearchQuery('sidebar "agent state" -cats ab');
    expect(q.terms).toEqual(["sidebar", "ab"]);
    expect(q.expression()).toBe('"sidebar"* AND "ab" AND "agent state" NOT "cats"*');
  });

  it("folds case and diacritics like the tokenizer", () => {
    expect(words("Über-Größe café")).toEqual(["uber", "große", "cafe"].map((w) => w.replace("ß", "ß")));
  });

  it("splits identifiers so parts are searchable", () => {
    const parts = identifierParts(["AgentMonitor.swift agent_status_store src/monitor/index.ts"]).split(" ");
    expect(parts).toEqual(expect.arrayContaining(["agent", "monitor", "swift", "status", "store", "index"]));
  });

  it("suggests typo corrections only for rare prefixes", () => {
    const v = new Vocabulary([
      { term: "sidebar", doc: 5 },
      { term: "agent", doc: 9 },
      { term: "agenda", doc: 2 },
    ]);
    expect(v.expansions("sidbar")).toEqual(["sidebar"]);
    expect(v.expansions("sidba")).toEqual(["sidebar"]); // as-you-type
    expect(v.expansions("agen")).toEqual([]); // common prefix: no guessing
  });
});

describe("index + search", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-search-"));
  const claudeCfg = path.join(dir, "claude");
  const projects = path.join(claudeCfg, "projects", "-Users-me-src-cmd");
  const archive = path.join(dir, "archive");
  const codex = path.join(dir, "codex", "2026", "10", "01");
  const roots: TranscriptRoot[] = [
    { agent: "claude", dir: path.join(claudeCfg, "projects"), configDir: claudeCfg, layout: "projects" },
    { agent: "claude", dir: archive, configDir: null, layout: "flat" },
    { agent: "codex", dir: path.join(dir, "codex"), configDir: null, layout: "tree" },
  ];
  let db: ReturnType<typeof openIndex>;
  let searcher: Searcher;

  beforeAll(() => {
    fs.mkdirSync(projects, { recursive: true });
    fs.mkdirSync(archive, { recursive: true });
    fs.mkdirSync(codex, { recursive: true });
    fs.writeFileSync(path.join(projects, "s-sidebar.jsonl"), claudeSession("s-sidebar", "make the sidebar collapsible", "Collapsible sidebar done."));
    fs.writeFileSync(path.join(projects, "s-vpn.jsonl"), claudeSession("s-vpn", "wireguard vpn keeps dropping", "Restarted wg-quick."));
    // the same session archived: must not show twice
    fs.writeFileSync(path.join(archive, "s-sidebar.jsonl"), claudeSession("s-sidebar", "make the sidebar collapsible", "Collapsible sidebar done."));
    fs.writeFileSync(
      path.join(codex, "rollout-2026-10-01T00-00-00-0199-codex-thread.jsonl"),
      jsonl({ type: "session_meta", payload: { id: "0199-codex-thread", cwd: "/repo" } }, { type: "event_msg", payload: { type: "user_message", message: "migrate the postgres schema" } }),
    );
    db = openIndex(path.join(dir, "search.sqlite"));
    expect(indexPass(db, roots)).toEqual({ changed: 4, removed: 0 });
    searcher = new Searcher(db);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("finds sessions by prompt words, with a highlighted snippet and resume info", () => {
    const hits = searcher.search("collapsible");
    expect(hits).toHaveLength(1); // archive copy deduplicated
    expect(hits[0]).toMatchObject({ sessionId: "s-sidebar", agent: "claude", cwd: "/Users/me/src/cmd", branch: "main" });
    expect(hits[0]!.snippet).toContain("\x01");
  });

  it("supports prefixes, phrases, exclusions, identifiers and Codex", () => {
    expect(searcher.search("wiregu").map((h) => h.sessionId)).toEqual(["s-vpn"]);
    expect(searcher.search('"keeps dropping"').map((h) => h.sessionId)).toEqual(["s-vpn"]);
    expect(searcher.search("sidebar -collapsible")).toEqual([]);
    expect(searcher.search("monitor").length).toBeGreaterThan(0); // from AgentMonitor.swift
    expect(searcher.search("postgres")[0]).toMatchObject({ agent: "codex", sessionId: "0199-codex-thread" });
  });

  it("tolerates typos", () => {
    const hits = searcher.search("wiregaurd");
    expect(hits[0]).toMatchObject({ sessionId: "s-vpn", fuzzy: true });
  });

  it("re-indexes changed files and forgets removed ones", () => {
    const messages = () => (db.prepare(`SELECT count(*) AS n FROM message_fts`).get() as { n: number }).n;
    const vpnMessages = () =>
      (db.prepare(`SELECT count(*) AS n FROM message_fts WHERE session = (SELECT rowid FROM sessions WHERE id = 's-vpn')`).get() as { n: number }).n;
    const before = messages();
    const vpnBefore = vpnMessages();
    const archived = (db.prepare(`SELECT msg_last - msg_first + 1 AS n FROM sessions WHERE path = ?`).get(path.join(archive, "s-sidebar.jsonl")) as { n: number }).n;
    fs.appendFileSync(path.join(projects, "s-vpn.jsonl"), jsonl({ type: "user", sessionId: "s-vpn", message: { role: "user", content: "also check tailscale" } }));
    fs.rmSync(path.join(archive, "s-sidebar.jsonl"));
    const r = indexPass(db, roots);
    expect(r).toEqual({ changed: 1, removed: 1 });
    searcher.invalidate();
    expect(searcher.search("tailscale").map((h) => h.sessionId)).toEqual(["s-vpn"]);
    // The changed session's old messages are replaced, not duplicated; the removed
    // copy's messages are gone; everyone else's stay.
    expect(vpnMessages()).toBe(vpnBefore + 1);
    expect(messages()).toBe(before + 1 - archived);
    expect(indexPass(db, roots)).toEqual({ changed: 0, removed: 0 });
  });
});

describe("resume commands", () => {
  it("resumes Claude (with CLAUDE_CONFIG_DIR for profiles) and Codex, or forks", () => {
    expect(resumeCommand("claude", "abc", path.join(os.homedir(), ".claude"), false)).toBe("claude --resume 'abc'");
    expect(resumeCommand("claude", "abc", "/Users/me/.claude-profiles/work", true)).toBe(
      "CLAUDE_CONFIG_DIR='/Users/me/.claude-profiles/work' claude --resume 'abc' --fork-session",
    );
    expect(resumeCommand("codex", "t1", null, false)).toBe("codex resume 't1'");
    expect(resumeCommand("codex", "t1", null, true)).toBe("codex fork 't1'");
  });
});

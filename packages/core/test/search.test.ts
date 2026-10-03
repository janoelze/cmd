import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanClaudePrompt, parseClaude, parseCodex, parseCopilot, parseQwen } from "../src/search/parser.ts";
import { identifierParts, SearchQuery, Vocabulary, words } from "../src/search/query.ts";
import { clearIndex, indexPass, learnedRoots, openIndex, saveLearnedRoot, Searcher, transcriptFiles } from "../src/search/index.ts";
import { registerBuiltinSources } from "../src/search/builtin.ts";
import { TranscriptSources, type TranscriptRoot } from "../src/search/sources.ts";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { rmTemp } from "./tmp.ts";

const sources = registerBuiltinSources(new TranscriptSources());

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
    const doc = parseClaude(claudeSession("s1", "fix the sidebar", "Done, sidebar fixed."), "/p/s1.jsonl")!;
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
    const doc = parseClaude(jsonl({ weird: { text: "hello future format" } }, { other: { message: "a reply" } }), "/p/f.jsonl")!;
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

const qwenSession = (id: string, prompt: string, reply: string) =>
  jsonl(
    { uuid: "u1", parentUuid: null, sessionId: id, timestamp: "2026-10-02T09:00:00Z", type: "user", cwd: "/Users/me/src/q", version: "0.24.7", gitBranch: "dev",
      message: { role: "user", parts: [{ text: `<context>injected</context>${prompt}` }] }, systemPayload: { displayText: prompt } },
    { uuid: "u2", parentUuid: "u1", sessionId: id, timestamp: "2026-10-02T09:01:00Z", type: "assistant", cwd: "/Users/me/src/q", version: "0.24.7",
      message: { role: "model", parts: [{ thought: true, text: "pondering" }, { text: reply }, { functionCall: { name: "read_file", args: { absolute_path: "/src/QueueWorker.ts" } } }] } },
    { uuid: "u3", parentUuid: "u2", sessionId: id, timestamp: "2026-10-02T09:01:01Z", type: "tool_result", cwd: "/Users/me/src/q", version: "0.24.7",
      message: { role: "user", parts: [{ functionResponse: { response: { output: "FILE CONTENTS" } } }] } },
    { uuid: "u4", parentUuid: "u3", sessionId: id, timestamp: "2026-10-02T09:02:00Z", type: "system", subtype: "custom_title", cwd: "/x", version: "0.24.7",
      systemPayload: { customTitle: "Queue worker retries" } },
    { uuid: "u5", sessionId: id, timestamp: "2026-10-02T09:03:00Z", type: "user", isSidechain: true, cwd: "/x", version: "0.24.7", message: { role: "user", parts: [{ text: "subagent noise" }] } },
  );

const copilotSession = (id: string, prompt: string, reply: string) =>
  jsonl(
    { type: "session.start", id: "e1", timestamp: "2026-10-03T08:00:00Z", parentId: null,
      data: { sessionId: id, version: 1, producer: "copilot-agent", startTime: "2026-10-03T08:00:00Z", context: { cwd: "/Users/me/src/c", branch: "feature" } } },
    { type: "user.message", id: "e2", timestamp: "2026-10-03T08:00:05Z", parentId: "e1", data: { content: prompt, transformedContent: `<wrapped>${prompt}</wrapped>` } },
    { type: "assistant.message", id: "e3", timestamp: "2026-10-03T08:00:09Z", parentId: "e2",
      data: { messageId: "m1", content: reply, toolRequests: [{ toolCallId: "t1", name: "bash", arguments: JSON.stringify({ command: "make lint", description: "Lint the tree" }) }] } },
    { type: "tool.execution_complete", id: "e4", timestamp: "2026-10-03T08:00:10Z", parentId: "e3", data: { result: "HUGE OUTPUT" } },
  );

describe("Qwen Code and Copilot CLI parsers", () => {
  it("Qwen: the prompt as typed, replies without thoughts, tool args, custom title; skips tool results and sidechains", () => {
    const doc = parseQwen(qwenSession("q-1", "fix the retry loop", "Retries now back off."), "/q/projects/-p/chats/q-1.jsonl")!;
    expect(doc).toMatchObject({ id: "q-1", agent: "qwen", cwd: "/Users/me/src/q", branch: "dev", title: "Queue worker retries" });
    expect(doc.prompts).toEqual(["fix the retry loop"]);
    expect(doc.responses).toEqual(["Retries now back off."]);
    expect(doc.tools).toEqual(["/src/QueueWorker.ts"]);
    expect(doc.startedAt).toBe(Date.parse("2026-10-02T09:00:00Z"));
  });

  it("Copilot: session id, cwd and branch from session.start, displayed prompts, tool request arguments", () => {
    const doc = parseCopilot(copilotSession("c-1", "add a lint step", "Added it."), "/c/session-state/c-1/events.jsonl")!;
    expect(doc).toMatchObject({ id: "c-1", agent: "copilot", cwd: "/Users/me/src/c", branch: "feature" });
    expect(doc.prompts).toEqual(["add a lint step"]);
    expect(doc.responses).toEqual(["Added it."]);
    expect(doc.tools).toEqual(["Lint the tree make lint"]);
    expect(JSON.stringify(doc)).not.toContain("HUGE OUTPUT");
  });
});

describe("index + search", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-search-"));
  const claudeCfg = path.join(dir, "claude");
  const projects = path.join(claudeCfg, "projects", "-Users-me-src-cmd");
  const archive = path.join(dir, "archive");
  const codex = path.join(dir, "codex", "2026", "10", "01");
  const qwen = path.join(dir, "qwen", "projects", "-Users-me-src-q", "chats");
  const copilot = path.join(dir, "copilot", "session-state");
  const roots: TranscriptRoot[] = [
    { agent: "claude", dir: path.join(claudeCfg, "projects"), depth: 2, env: { CLAUDE_CONFIG_DIR: claudeCfg } },
    { agent: null, dir: archive, depth: 2, env: null },
    { agent: "codex", dir: path.join(dir, "codex"), env: null },
    { agent: "qwen", dir: path.join(dir, "qwen", "projects"), depth: 4, env: null },
    { agent: "copilot", dir: copilot, depth: 2, fileName: "events.jsonl", env: null },
  ];
  let db: ReturnType<typeof openIndex>;
  let searcher: Searcher;

  beforeAll(() => {
    fs.mkdirSync(projects, { recursive: true });
    fs.mkdirSync(archive, { recursive: true });
    fs.mkdirSync(codex, { recursive: true });
    fs.writeFileSync(path.join(projects, "s-sidebar.jsonl"), claudeSession("s-sidebar", "make the sidebar collapsible", "Collapsible sidebar done."));
    fs.writeFileSync(path.join(projects, "s-vpn.jsonl"), claudeSession("s-vpn", "wireguard vpn keeps dropping", "Restarted wg-quick."));
    // a subagent log: below the root's depth, not indexed
    fs.mkdirSync(path.join(projects, "s-vpn", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(projects, "s-vpn", "subagents", "agent-1.jsonl"), claudeSession("s-vpn", "subagent kumquat", "kumquat"));
    // the same session archived: must not show twice
    fs.writeFileSync(path.join(archive, "s-sidebar.jsonl"), claudeSession("s-sidebar", "make the sidebar collapsible", "Collapsible sidebar done."));
    // a Codex session in the mixed archive folder: its agent is sniffed
    fs.writeFileSync(
      path.join(archive, "rollout-2026-09-01T00-00-00-0198-archived.jsonl"),
      jsonl({ type: "session_meta", payload: { id: "0198-archived", cwd: "/old" } }, { type: "event_msg", payload: { type: "user_message", message: "tune the rabbitmq consumers" } }),
    );
    fs.writeFileSync(
      path.join(codex, "rollout-2026-10-01T00-00-00-0199-codex-thread.jsonl"),
      jsonl({ type: "session_meta", payload: { id: "0199-codex-thread", cwd: "/repo" } }, { type: "event_msg", payload: { type: "user_message", message: "migrate the postgres schema" } }),
    );
    fs.mkdirSync(path.join(qwen, "archive"), { recursive: true });
    fs.writeFileSync(path.join(qwen, "q-live.jsonl"), qwenSession("q-live", "fix the retry loop", "Retries now back off."));
    fs.writeFileSync(path.join(qwen, "archive", "q-old.jsonl"), qwenSession("q-old", "rename the zebra module", "Renamed."));
    // a Qwen session in the mixed archive: Claude-like, but must be sniffed as Qwen
    fs.writeFileSync(path.join(archive, "q-archived.jsonl"), qwenSession("q-archived", "explain the walrus operator", "It assigns."));
    fs.mkdirSync(path.join(copilot, "c-1", "checkpoints"), { recursive: true });
    fs.writeFileSync(path.join(copilot, "c-1", "events.jsonl"), copilotSession("c-1", "add a lint step", "Added it."));
    fs.writeFileSync(path.join(copilot, "c-1", "other.jsonl"), jsonl({ text: "not a transcript" })); // only events.jsonl counts
    db = openIndex(path.join(dir, "search.sqlite"));
    expect(indexPass(db, roots, sources)).toEqual({ changed: 9, removed: 0 });
    searcher = new Searcher(db);
  });
  afterAll(() => {
    db.close(); // Windows can't delete an open database file
    rmTemp(dir);
  });

  it("finds sessions by prompt words, with a highlighted snippet and resume info", () => {
    const hits = searcher.search("collapsible");
    expect(hits).toHaveLength(1); // archive copy deduplicated
    expect(hits[0]).toMatchObject({ sessionId: "s-sidebar", agent: "claude", cwd: "/Users/me/src/cmd", branch: "main", env: { CLAUDE_CONFIG_DIR: claudeCfg } });
    expect(hits[0]!.snippet).toContain("\x01");
  });

  it("supports prefixes, phrases, exclusions, identifiers and Codex", () => {
    expect(searcher.search("wiregu").map((h) => h.sessionId)).toEqual(["s-vpn"]);
    expect(searcher.search('"keeps dropping"').map((h) => h.sessionId)).toEqual(["s-vpn"]);
    expect(searcher.search("sidebar -collapsible")).toEqual([]);
    expect(searcher.search("monitor").length).toBeGreaterThan(0); // from AgentMonitor.swift
    expect(searcher.search("postgres")[0]).toMatchObject({ agent: "codex", sessionId: "0199-codex-thread" });
    expect(searcher.search("rabbitmq")[0]).toMatchObject({ agent: "codex", sessionId: "0198-archived", env: null });
    expect(searcher.search("kumquat")).toEqual([]);
    expect(searcher.search("retry")[0]).toMatchObject({ agent: "qwen", sessionId: "q-live", title: "Queue worker retries", branch: "dev" });
    expect(searcher.search("queueworker").map((h) => h.sessionId)).toContain("q-live"); // tool args, identifier parts
    expect(searcher.search("zebra")[0]).toMatchObject({ agent: "qwen", sessionId: "q-old" }); // chats/archive
    expect(searcher.search("walrus")[0]).toMatchObject({ agent: "qwen", sessionId: "q-archived" });
    expect(searcher.search("lint")[0]).toMatchObject({ agent: "copilot", sessionId: "c-1", cwd: "/Users/me/src/c" });
    expect(searcher.search("transcript")).toEqual([]);
  });

  it("lists recent sessions once each, leaving out excluded ones", () => {
    const ids = searcher.recent(10).map((h) => h.sessionId);
    expect(ids.sort()).toEqual(["0198-archived", "0199-codex-thread", "c-1", "q-archived", "q-live", "q-old", "s-sidebar", "s-vpn"]);
    expect(searcher.recent(10, ["s-vpn"]).map((h) => h.sessionId)).not.toContain("s-vpn");
    expect(searcher.recent(1)).toHaveLength(1);
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
    const r = indexPass(db, roots, sources);
    expect(r).toEqual({ changed: 1, removed: 1 });
    searcher.invalidate();
    expect(searcher.search("tailscale").map((h) => h.sessionId)).toEqual(["s-vpn"]);
    // The changed session's old messages are replaced, not duplicated; the removed
    // copy's messages are gone; everyone else's stay.
    expect(vpnMessages()).toBe(vpnBefore + 1);
    expect(messages()).toBe(before + 1 - archived);
    expect(indexPass(db, roots, sources)).toEqual({ changed: 0, removed: 0 });
  });

  it("rebuilds from scratch, keeping learned folders; big passes announce their size first", () => {
    saveLearnedRoot(db, { agent: "claude", dir: "/learned/projects", depth: 2, env: null });
    const before = searcher.recent(50).length;
    clearIndex(db);
    searcher.invalidate();
    expect(searcher.search("collapsible")).toEqual([]);
    const progress: [number, number][] = [];
    const r = indexPass(db, roots, sources, (done, total) => progress.push([done, total]));
    expect(r.changed).toBe(transcriptFiles(roots).length);
    expect(progress.at(-1)).toEqual([r.changed, r.changed]);
    expect(searcher.recent(50)).toHaveLength(before);
    expect(learnedRoots(db).map((l) => l.dir)).toEqual(["/learned/projects"]);
  });
});

describe("transcript sources", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-sources-"));
  const mk = (...p: string[]) => fs.mkdirSync(path.join(home, ...p), { recursive: true });
  afterAll(() => rmTemp(home));

  it("finds every Claude config dir and Codex home; non-default ones carry the env to resume", () => {
    mk(".claude", "projects");
    mk(".claude-profiles", "work", "projects");
    mk(".claude-profiles", "empty"); // no projects: skipped
    mk("elsewhere", "claude", "projects");
    mk(".codex", "sessions");
    mk(".codex", "archived_sessions");
    mk("alt-codex", "sessions");
    mk(".qwen", "projects");
    mk("qwen-runtime", "projects");
    mk(".copilot", "session-state");
    mk("archive");
    const real = (...p: string[]) => fs.realpathSync(path.join(home, ...p));
    const env = { CLAUDE_CONFIG_DIR: path.join(home, "elsewhere", "claude"), CODEX_HOME: path.join(home, "alt-codex"), QWEN_RUNTIME_DIR: path.join(home, "qwen-runtime") };
    const roots = sources.locate({ home, env }, ["~/archive", "~/missing"]);
    expect(roots).toEqual([
      { agent: "claude", dir: path.join(real(".claude"), "projects"), depth: 2, env: null },
      { agent: "claude", dir: path.join(real("elsewhere", "claude"), "projects"), depth: 2, env: { CLAUDE_CONFIG_DIR: real("elsewhere", "claude") } },
      { agent: "claude", dir: path.join(real(".claude-profiles", "work"), "projects"), depth: 2, env: { CLAUDE_CONFIG_DIR: real(".claude-profiles", "work") } },
      { agent: "codex", dir: path.join(real(".codex"), "sessions"), env: null },
      { agent: "codex", dir: path.join(real(".codex"), "archived_sessions"), env: null },
      { agent: "codex", dir: path.join(real("alt-codex"), "sessions"), env: { CODEX_HOME: real("alt-codex") } },
      { agent: "qwen", dir: path.join(real(".qwen"), "projects"), depth: 4, env: null },
      { agent: "qwen", dir: path.join(real("qwen-runtime"), "projects"), depth: 4, env: { QWEN_RUNTIME_DIR: real("qwen-runtime") } },
      { agent: "copilot", dir: path.join(real(".copilot"), "session-state"), depth: 2, fileName: "events.jsonl", env: null },
      { agent: null, dir: path.join(home, "archive"), depth: 2, env: null },
    ]);
  });

  it("learns the folder of a transcript a live agent reports, unless a known root covers it", () => {
    mk("odd", "cfg", "projects", "-p");
    mk("odd", "codexhome", "sessions", "2026", "10", "01");
    const ctx = { home, env: {} };
    const known = sources.locate(ctx);
    const cfg = fs.realpathSync(path.join(home, "odd", "cfg"));
    expect(sources.learn("claude", path.join(cfg, "projects", "-p", "s.jsonl"), known, ctx)).toEqual({
      agent: "claude", dir: path.join(cfg, "projects"), depth: 2, env: { CLAUDE_CONFIG_DIR: cfg },
    });
    const codexHome = fs.realpathSync(path.join(home, "odd", "codexhome"));
    expect(sources.learn("codex", path.join(codexHome, "sessions", "2026", "10", "01", "rollout-x.jsonl"), known, ctx)).toMatchObject({
      agent: "codex", dir: path.join(codexHome, "sessions"), env: { CODEX_HOME: codexHome },
    });
    mk("odd", "qbase", "projects", "-p", "chats", "archive");
    const qbase = fs.realpathSync(path.join(home, "odd", "qbase"));
    expect(sources.learn("qwen", path.join(qbase, "projects", "-p", "chats", "archive", "q.jsonl"), known, ctx)).toMatchObject({
      agent: "qwen", dir: path.join(qbase, "projects"), env: { QWEN_RUNTIME_DIR: qbase },
    });
    mk("odd", "cop", "session-state", "c-9");
    const cop = fs.realpathSync(path.join(home, "odd", "cop"));
    expect(sources.learn("copilot", path.join(cop, "session-state", "c-9", "events.jsonl"), known, ctx)).toMatchObject({
      agent: "copilot", dir: path.join(cop, "session-state"), env: { COPILOT_HOME: cop },
    });
    expect(sources.learn("copilot", path.join(cop, "session-state", "c-9", "other.jsonl"), known, ctx)).toBeNull();
    expect(sources.learn("claude", path.join(known[0]!.dir, "-p", "s.jsonl"), known, ctx)).toBeNull(); // already covered
    expect(sources.learn("claude", path.join(home, "random", "s.jsonl"), known, ctx)).toBeNull(); // unknown layout
    expect(sources.learn("gemini", path.join(home, "x", "s.jsonl"), known, ctx)).toBeNull(); // no source
  });

  it("walks roots only as deep as allowed", () => {
    mk("deep", "a", "b");
    for (const p of ["deep/1.jsonl", "deep/a/2.jsonl", "deep/a/b/3.jsonl", "deep/a/x.txt"]) fs.writeFileSync(path.join(home, p), "");
    const names = (depth?: number) => transcriptFiles([{ agent: null, dir: path.join(home, "deep"), depth, env: null }]).map((f) => path.basename(f.path)).sort();
    expect(names(1)).toEqual(["1.jsonl"]);
    expect(names(2)).toEqual(["1.jsonl", "2.jsonl"]);
    expect(names()).toEqual(["1.jsonl", "2.jsonl", "3.jsonl"]);
  });
});

describe("resume commands", () => {
  it("resumes each agent (with the env its folder needs), or forks where it can", () => {
    const cmd = (agent: string, id: string, env: Record<string, string> | null, fork: boolean) => sources.resumeCommand(agent, id, env, fork, DEFAULT_SETTINGS);
    expect(cmd("claude", "abc", null, false)).toBe("claude --resume 'abc'");
    expect(cmd("claude", "abc", { CLAUDE_CONFIG_DIR: "/Users/me/.claude-profiles/work" }, true)).toBe(
      "CLAUDE_CONFIG_DIR='/Users/me/.claude-profiles/work' claude --resume 'abc' --fork-session",
    );
    expect(cmd("codex", "t1", null, false)).toBe("codex resume 't1'");
    expect(cmd("codex", "t1", { CODEX_HOME: "/alt" }, true)).toBe("CODEX_HOME='/alt' codex fork 't1'");
    expect(cmd("qwen", "q1", { QWEN_RUNTIME_DIR: "/rt" }, true)).toBe("QWEN_RUNTIME_DIR='/rt' qwen --resume 'q1' --fork-session");
    expect(cmd("copilot", "c1", null, false)).toBe("copilot --resume='c1'");
    expect(() => cmd("copilot", "c1", null, true)).toThrow(/Copilot CLI can't fork/);
    expect(() => cmd("nope", "x", null, false)).toThrow(/can't resume nope/);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summaryText, isSummary, type Agent, type AgentTurn } from "@cmd/protocol";
import { parseClaude, parseCodex, type ConversationEntry } from "../src/search/parser.ts";
import { cut, prune, redact, shrinkBlocks } from "../src/summaries/prune.ts";
import { renderSummary, SUMMARY_SCHEMA, type SummaryFacts, type SummaryText } from "../src/summaries/render.ts";
import { SummaryService, type SummaryAi } from "../src/summaries/service.ts";

const jl = (...xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n");

describe("conversation order", () => {
  it("Claude: prompts, replies and tool calls as they happened", () => {
    const text = jl(
      { type: "user", timestamp: "2026-10-05T10:00:00Z", message: { role: "user", content: "fix the build" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Bash", input: { command: "pnpm build" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed." }] } },
    );
    const out: ConversationEntry[] = [];
    parseClaude(text, "/x/s.jsonl", out);
    expect(out.map((e) => [e.role, e.text])).toEqual([
      ["user", "fix the build"],
      ["assistant", "Looking."],
      ["tool", "Bash: pnpm build"],
      ["assistant", "Fixed."],
    ]);
    expect(out[0]!.at).toBe(Date.parse("2026-10-05T10:00:00Z"));
  });

  it("Codex: events in file order, user text not twice", () => {
    const text = jl(
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a test" }] } },
      { type: "event_msg", payload: { type: "user_message", message: "add a test" } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "pnpm test"] }) } },
      { type: "event_msg", payload: { type: "agent_message", message: "Added." } },
    );
    const out: ConversationEntry[] = [];
    parseCodex(text, "/x/rollout.jsonl", out);
    expect(out.map((e) => [e.role, e.text])).toEqual([
      ["user", "add a test"],
      ["tool", "shell: pnpm test"],
      ["assistant", "Added."],
    ]);
  });
});

describe("pruning", () => {
  it("cut keeps the start and the end and says how much went", () => {
    const t = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const c = cut(t, 300);
    expect(c.length).toBeLessThan(340);
    expect(c.startsWith("line 0\n")).toBe(true);
    expect(c.endsWith("line 399")).toBe(true);
    expect(c).toMatch(/\[… [\d,]+ characters cut …\]/);
    expect(cut("short", 300)).toBe("short");
  });

  it("shrinks long code blocks and pasted output, not prose", () => {
    const code = ["Here is the log:", "```", ...Array.from({ length: 100 }, (_, i) => `x${i}`), "```", "That's the error."].join("\n");
    const s = shrinkBlocks(code, 10);
    expect(s).toContain("x0");
    expect(s).toContain("x99");
    expect(s).not.toContain("x50");
    expect(s).toMatch(/\[… 90 lines cut …\]/);
    expect(s).toContain("That's the error.");
    const log = Array.from({ length: 80 }, (_, i) => `2026-10-05 12:00:${i} ERROR thing ${i}`).join("\n");
    expect(shrinkBlocks(log, 10).split("\n").length).toBeLessThan(15);
    const prose = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} of a long explanation.`).join("\n");
    expect(shrinkBlocks(prose, 10)).toBe(prose);
  });

  it("leaves a conversation that fits alone", () => {
    const es: ConversationEntry[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    const p = prune(es, 10_000);
    expect(p.entries).toEqual(es);
    expect(p.omitted).toBe(0);
  });

  it("fits a long session into the budget, keeping every prompt and the latest messages", () => {
    const es: ConversationEntry[] = [];
    for (let i = 0; i < 200; i++) {
      es.push({ role: "user", text: `prompt ${i}: ${"please ".repeat(10)}` });
      for (let j = 0; j < 10; j++) es.push({ role: "tool", text: `Bash: step ${i}.${j}` });
      es.push({ role: "assistant", text: `reply ${i}: ${"word ".repeat(2000)}` });
    }
    const p = prune(es, 60_000);
    expect(p.after).toBeLessThanOrEqual(60_000);
    expect(p.before).toBeGreaterThan(p.after);
    const prompts = p.entries.filter((e) => e.role === "user");
    expect(prompts.length).toBe(200);
    expect(p.entries.at(-1)!.text.startsWith("reply 199")).toBe(true);
    // The latest reply is cut least.
    const last = p.entries.at(-1)!.text.length;
    const first = p.entries.find((e) => e.role === "assistant")!.text.length;
    expect(last).toBeGreaterThan(first);
    expect(p.entries.some((e) => /more tool calls|messages left out/.test(e.text))).toBe(true);
  });

  it("drops old messages, never the first prompt, when cutting isn't enough", () => {
    const es: ConversationEntry[] = Array.from({ length: 3000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `message ${i} ${"x".repeat(200)}` }) as ConversationEntry);
    const p = prune(es, 20_000);
    expect(p.after).toBeLessThanOrEqual(20_000);
    expect(p.omitted).toBeGreaterThan(0);
    expect(p.entries[0]!.text.startsWith("message 0")).toBe(true);
    expect(p.entries.at(-1)!.text.startsWith("message 2999")).toBe(true);
  });
});

describe("redact", () => {
  it("masks keys, tokens and passwords", () => {
    const t = [
      "export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "git clone https://jan:hunter2secret@example.com/repo.git",
      '{"password": "correct-horse-battery"}',
      "AKIAABCDEFGHIJKLMNOP",
    ].join("\n");
    const r = redact(t);
    expect(r).not.toMatch(/sk-ant-api03|ghp_abc|hunter2|correct-horse|AKIAABCD/);
    expect(r).toContain("[redacted]");
    expect(r).toContain("https://jan:[redacted]@example.com");
  });

  it("leaves code that names secrets alone", () => {
    const code = "const key = process.env.API_KEY;\nAPI_KEY=$API_KEY ./run\ntoken: <your token>";
    expect(redact(code)).toBe(code);
  });
});

describe("schema", () => {
  /** OpenAI's strict structured outputs: every object lists all its keys as required and allows no others. */
  function checkStrict(s: Record<string, unknown>, at = "root"): string[] {
    const errs: string[] = [];
    if (s.type === "object") {
      const props = Object.keys((s.properties ?? {}) as object);
      const req = (s.required ?? []) as string[];
      for (const k of props) if (!req.includes(k)) errs.push(`${at}: ${k} not required`);
      if (s.additionalProperties !== false) errs.push(`${at}: additionalProperties`);
      for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, Record<string, unknown>>)) errs.push(...checkStrict(v, `${at}.${k}`));
    }
    if (s.type === "array" && s.items) errs.push(...checkStrict(s.items as Record<string, unknown>, `${at}[]`));
    return errs;
  }

  it("is valid as an OpenAI strict schema", () => {
    expect(checkStrict(SUMMARY_SCHEMA as unknown as Record<string, unknown>)).toEqual([]);
  });
});

const facts: SummaryFacts = {
  agent: "Claude Code",
  project: "cmd",
  cwd: "/src/cmd",
  branch: "summary",
  startedAt: Date.parse("2026-10-05T10:00:00"),
  endedAt: Date.parse("2026-10-05T10:42:00"),
  prompts: 3,
  files: [{ path: "src/a.ts", change: "M" }, { path: "src/b.ts", change: "?" }],
  commits: [{ hash: "abc1234", subject: "Add summaries" }],
};

const answer: SummaryText = {
  title: "Session summaries",
  body: "Added summaries.\n\n# Why a file\n\n- Stream into a file, not a widget\n\n---\n\n## Files changed by hand\n\nmore",
};

describe("render", () => {
  it("renders the facts at once, the rest as it arrives", () => {
    const md = renderSummary(facts, {}, { pending: "Summarizing…" });
    expect(isSummary(md)).toBe(true);
    expect(md).toContain("# Session in cmd");
    expect(md).toContain("Claude Code · cmd · `summary` · ");
    expect(md).toContain("(42 min)");
    expect(md).toContain("`src/b.ts` (new)");
    expect(md).not.toContain("abc1234"); // commits are for the model only
    expect(renderSummary(facts, { title: "Sess", body: "Half a sent" })).toContain("Half a sent\n");
  });

  it("dates a session resumed on another day", () => {
    const md = renderSummary({ ...facts, startedAt: Date.parse("2026-09-17T20:25:00"), endedAt: Date.parse("2026-09-21T18:31:00") }, {});
    expect(md).toContain("Sep 17, 20:25 – Sep 21, 18:31");
    expect(md).not.toMatch(/\d+ h \d+ min/);
  });

  it("keeps the body's headings under the title and away from the app's", () => {
    const md = renderSummary(facts, answer);
    expect(md).toContain("\n## Why a file\n");
    expect(md).toContain("## Files changed by hand (summary)");
    expect(md.match(/^# /gm)).toHaveLength(1);
  });

  it("leaves out sections the model wrote only to say there's nothing", () => {
    const md = renderSummary(facts, { body: "## The ask\nA test.\n\n## What changed\nNothing changed.\n\n## Next steps\nNone.\n" });
    expect(md).toContain("## What changed\nNothing changed.");
    expect(md).not.toContain("## Next steps");
    expect(renderSummary(facts, { body: "## Next steps\n\nN/A\n\n## Notes\nkept" })).toMatch(/## Notes\nkept/);
    expect(renderSummary(facts, { body: "## Next steps\n\nN/A\n\n## Notes\nkept" })).not.toContain("N/A");
  });

  it("copies the summary as edited, without marker, progress line or footer", () => {
    const md = renderSummary(facts, answer, { footer: "Written by Haiku" });
    const text = summaryText(md)!;
    expect(text.startsWith("# Session summaries")).toBe(true);
    // The body's own rule isn't taken for the footer.
    expect(text).toContain("more");
    expect(text).toContain("## Files changed (2)");
    expect(text).not.toMatch(/Written by|cmd:session-summary/);
    expect(summaryText(md.replace("Added summaries.", "We shipped summaries."))).toContain("We shipped summaries.");
    expect(summaryText(renderSummary(facts, {}, { pending: "Writing…" }))).not.toContain("Writing…");
  });
});

describe("SummaryService", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  function setup(ai: Partial<SummaryAi> & { object: SummaryAi["object"] }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-summaries-"));
    dirs.push(dir);
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      transcript,
      jl(
        { type: "user", timestamp: "2026-10-05T10:00:00Z", cwd: "/src/cmd", gitBranch: "main", message: { role: "user", content: "add a README section, my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz" } },
        { type: "assistant", timestamp: "2026-10-05T10:05:00Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
      ),
    );
    const agent = { id: "a1", kind: "claude", cwd: "/src/cmd", spaceId: "s1", native: { claudeSessionId: "sess-1234-abcd", transcriptPath: transcript } } as unknown as Agent;
    const turns = [{ sessionId: "sess-1234-abcd", startedAt: 1, endedAt: 2, files: [{ path: "/src/cmd/README.md", change: "M", via: ["git"] }] }] as unknown as AgentTurn[];
    const shown: string[] = [];
    const notes: string[] = [];
    const svc = new SummaryService({
      ai: { modelName: () => "Claude Haiku 4.5", ...ai },
      agent: (id) => (id === "a1" ? agent : null),
      turns: () => turns,
      agentTitle: () => "Claude Code",
      dir,
      show: (f) => (shown.push(f), "w1"),
      notify: (_id, title, body) => notes.push(`${title}: ${body}`),
      commits: async () => [{ hash: "abc1234", subject: "README" }],
      branch: async () => "main",
    });
    return { svc, shown, notes };
  }

  it("writes the facts first, streams the answer into the file, then notifies", async () => {
    let prompt = "";
    const seen: string[] = [];
    const { svc, shown, notes } = setup({
      object: async <T,>(o: Parameters<SummaryAi["object"]>[0]) => {
        const file = shown[0]!;
        prompt = o.prompt;
        seen.push(fs.readFileSync(file, "utf8"));
        o.onPartial?.({ title: "README sect" } as never);
        await new Promise((r) => setTimeout(r, 300));
        seen.push(fs.readFileSync(file, "utf8"));
        return { value: answer as T, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, model: "m" };
      },
    });
    const start = svc.start("a1");
    const s = await start;
    expect(s.windowId).toBe("w1");
    expect(shown).toEqual([s.path]);
    expect(path.basename(s.path)).toBe("cmd-2026-10-05-sess-123.md");
    const md = await s.done;
    expect(seen[0]).toContain("Summarizing 1 prompt with Claude Haiku 4.5…");
    expect(seen[0]).toContain("`README.md`");
    expect(seen[1]).toContain("# README sect");
    expect(md).toContain("# Session summaries");
    expect(md).toContain("Written by Claude Haiku 4.5 from 2 messages");
    expect(fs.readFileSync(s.path, "utf8")).toBe(md);
    expect(notes).toEqual(["Summary ready: Session summaries"]);
    // Secrets never reach the provider.
    expect(prompt).not.toContain("sk-ant-api03");
    expect(prompt).toContain("[redacted]");
    expect(prompt).toContain("abc1234 README");
    expect(prompt).toMatch(/\n1\. \d\d:\d\d add a README section/);
  });

  it("asking again while it's written shows the same one", async () => {
    let calls = 0;
    let release!: () => void;
    const { svc } = setup({
      object: async <T,>() => {
        calls++;
        await new Promise<void>((r) => (release = r));
        return { value: answer as T, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model: "m" };
      },
    });
    const [a, b] = await Promise.all([svc.start("a1"), svc.start("a1")]);
    expect(a).toBe(b);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await a.done;
    expect(calls).toBe(1);
    // Done: the next one is a new run.
    const c = await svc.start("a1");
    expect(c).not.toBe(a);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await c.done;
  });

  it("a failed call says why in the file", async () => {
    const { svc, notes } = setup({ object: async () => Promise.reject(new Error("Invalid schema.")) });
    const s = await svc.start("a1");
    await expect(s.done).rejects.toThrow("Invalid schema.");
    expect(fs.readFileSync(s.path, "utf8")).toContain("The summary couldn't be written:** Invalid schema.");
    expect(notes).toEqual(["Summary failed: Invalid schema."]);
  });

  it("refuses before writing anything without a provider", async () => {
    const { svc, shown } = setup({ object: async () => Promise.reject(new Error("unused")), modelName: () => null });
    await expect(svc.start("a1")).rejects.toThrow(/No AI provider/);
    expect(shown).toEqual([]);
  });
});

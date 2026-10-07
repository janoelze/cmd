import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, AgentTurn } from "@cmd/protocol";
import { agentNotice, cleanAiBody, gist, noticeContext, plain, subjectOf } from "../src/agents/notice.ts";
import { newTurn } from "../src/agents/activity/reduce.ts";

const agent = (o: Partial<Agent> = {}, turn: Partial<AgentTurn> = {}): Agent => ({
  id: "a1", paneId: "p1", spaceId: "home", kind: "claude", name: "Agent activity", cwd: "/nowhere/cmd-agent-activity",
  parentId: null, rootId: "a1", depth: 0, spawn: { source: "detected" }, native: {}, state: "done", stateSince: 0,
  detail: null, lastMessage: null, lastPrompt: null, seenAt: null, createdAt: 0,
  turn: { ...newTurn("a1", 0, 0, undefined, { agentKind: "claude" }), ...turn },
  ...o,
});

describe("agent notifications", () => {
  it("done: the agent's first sentence without Markdown, then what cmd checked", () => {
    const n = agentNotice(agent({}, {
      final: "Session summaries are built and committed on the `summary` branch in `~/src/cmd-summary`. Here's what changed:\n\n- **core**: …",
      files: [1, 2, 3, 4].map((i) => ({ path: `/r/f${i}`, change: "M", via: ["git"] as ("git" | "fs" | "tool")[] })),
      startedAt: 0, endedAt: 7 * 60_000,
    }), "done");
    expect(n.title).toBe("Agent activity · done");
    expect(n.body).toBe("Session summaries are built and committed on the summary branch in… 4 files changed.");
  });

  it("done with work left running says so in the title", () => {
    expect(agentNotice(agent({}, { final: "Running the script in the background.", background: ["python3 report.py"], startedAt: 0, endedAt: 40_000 }), "done").title).toBe("Agent activity · done, 1 task still running");
  });

  it("needs you: what it asks, plainly", () => {
    const shell = agentNotice(agent({ state: "needs_input" }, { ask: { message: "Allow Bash?", tool: "Bash", input: "rm -- NOTES.md" } }), "needs");
    expect(shell).toEqual({ title: "Agent activity · needs you", body: "Allow “rm -- NOTES.md”?" });
    const edit = agentNotice(agent({ state: "needs_input" }, { ask: { message: "Allow apply_patch?", tool: "apply_patch", input: "/r/calc.py" } }), "needs");
    expect(edit.body).toBe("Allow editing “calc.py”?");
    const question = agentNotice(agent({ state: "needs_input", detail: "Claude needs your permission" }, { ask: null }), "needs");
    expect(question.body).toBe("Claude needs your permission");
  });

  it("stopped: why, in the agent's words", () => {
    expect(agentNotice(agent({ state: "failed" }, { error: "You've hit your weekly limit · resets Oct 7 at 3am (Europe/Berlin)" }), "stopped")).toEqual({
      title: "Agent activity · stopped",
      body: "You've hit your weekly limit · resets Oct 7 at 3am (Europe/Berlin)",
    });
  });

  it("names the agent by its name, else its kind, never its project", () => {
    expect(subjectOf({ name: null, kind: "claude" })).toBe("Claude");
    expect(subjectOf({ name: "Tours", kind: "codex" })).toBe("Tours");
    expect(subjectOf({ name: null, kind: "opencode" })).toBe("OpenCode");
  });

  it("skips Markdown headings in the agent's words", () => {
    expect(gist("## What a name is for\n\nA name is how you'd point at an agent.")).toBe("A name is how you'd point at an agent.");
  });

  it("keeps titles and bodies short", () => {
    const n = agentNotice(agent({ name: "A very long name for testing the limits" }, { final: "word ".repeat(80), startedAt: 0, endedAt: 1000 }), "done");
    expect(n.title).toBe("A very long name for… · done");
    expect(n.body.length).toBeLessThanOrEqual(140);
    expect(n.body).toMatch(/…$/);
  });
});

describe("text helpers", () => {
  it("strips Markdown", () => {
    expect(plain("## Done\n\nFixed **add()** in [calc.py](/r/calc.py:1), see `git diff`.\n\n```\ncode\n```")).toBe("Done Fixed add() in calc.py, see git diff.");
  });

  it("takes the first sentence, skipping a filler opener, cut at a clause", () => {
    expect(gist("Fixed it. Then ran the tests, all 12 pass. More.")).toBe("Fixed it.");
    expect(gist("Sure. Here's the list you asked for.")).toBe("Here's the list you asked for.");
    expect(gist("The release is out, signed, notarized and verified against every check we have", 40)).toBe("The release is out, signed…");
    expect(gist("The add() bug is fixed and the tests pass. Details follow.")).toBe("The add() bug is fixed and the tests pass.");
    expect(gist("Version 1.2.3 is out and tagged.")).toBe("Version 1.2.3 is out and tagged.");
  });
});

describe("AI wording", () => {
  it("keeps a model's answer to one plain, short line", () => {
    expect(cleanAiBody("Fixed `add()`; tests pass")).toBe("Fixed add(); tests pass.");
    expect(cleanAiBody('"Wants to run rm NOTES.md."\n\nExplanation: …')).toBe("Wants to run rm NOTES.md.");
    expect(cleanAiBody("  ")).toBeNull();
    expect(cleanAiBody("word ".repeat(40))!.length).toBeLessThanOrEqual(90);
  });

  it("gives the model the turn's facts, not its process", () => {
    const c = noticeContext(agent({}, { prompt: "fix it", final: "Fixed.", files: [{ path: "/r/calc.py", change: "M", via: ["git"] }], commands: ["npm test"], startedAt: 0, endedAt: 60_000 }), "done");
    expect(c).toMatchObject({ state: "done", prompt: "fix it", finalMessage: "Fixed.", filesChanged: ["calc.py"] });
    expect(c).not.toHaveProperty("recentCommands");
    const needs = noticeContext(agent({ state: "needs_input" }, { ask: { message: "Allow Bash?", tool: "Bash", input: "rm x" } }), "needs");
    expect(needs).toMatchObject({ state: "needs", asking: { input: "rm x" } });
    expect(needs.finalMessage).toBeUndefined();
  });
});

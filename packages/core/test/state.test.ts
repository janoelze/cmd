import { describe, expect, it } from "vitest";
import { applyHook, describeTool } from "../src/agents/state.ts";

describe("applyHook", () => {
  it("maps the Claude lifecycle", () => {
    expect(applyHook("claude", "UserPromptSubmit", {}).state).toBe("working");
    expect(applyHook("claude", "PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/a/b/x.ts" } })).toMatchObject({
      state: "working",
      detail: "Editing x.ts",
    });
    expect(applyHook("claude", "Stop", { last_assistant_message: "All done" })).toMatchObject({
      state: "done",
      lastMessage: "All done",
    });
    expect(applyHook("claude", "SessionEnd", {}).state).toBe("exited");
  });

  it("treats permission notifications as needs_input but not idle reminders", () => {
    expect(applyHook("claude", "Notification", { notification_type: "permission_prompt", message: "Allow Bash?" })).toMatchObject({
      state: "needs_input",
      detail: "Allow Bash?",
    });
    expect(applyHook("claude", "Notification", { notification_type: "idle_prompt" }).state).toBeUndefined();
  });

  it("records native ids per agent kind", () => {
    expect(applyHook("claude", "SessionStart", { session_id: "s1", transcript_path: "/t.jsonl" }).native).toEqual({
      claudeSessionId: "s1",
      transcriptPath: "/t.jsonl",
    });
    expect(applyHook("codex", "SessionStart", { session_id: "th1" }).native).toEqual({ codexThreadId: "th1" });
  });

  it("routes events from inside a subagent to the child", () => {
    const start = applyHook("claude", "SubagentStart", { agent_id: "a1", agent_type: "Explore" });
    expect(start.subagent).toEqual({ op: "start", id: "a1", type: "Explore" });
    expect(start.state).toBeUndefined();
    // tool use inside the subagent must not change the parent's detail
    expect(applyHook("claude", "PreToolUse", { agent_id: "a1", tool_name: "Read" }).detail).toBeUndefined();
  });
});

describe("describeTool", () => {
  it("summarizes common tools", () => {
    expect(describeTool("Bash", { command: "pnpm test\nmore" })).toBe("pnpm test");
    expect(describeTool("Bash", { command: "x", description: "Run the tests" })).toBe("Run the tests");
    expect(describeTool("WebFetch", { url: "https://docs.example.com/a" })).toBe("Fetching docs.example.com");
    expect(describeTool("mcp__github__create_pr", {})).toBe("github create pr");
  });
});

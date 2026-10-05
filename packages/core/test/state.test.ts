import { describe, expect, it } from "vitest";
import { describeTool } from "../src/agents/state.ts";

describe("describeTool", () => {
  it("summarizes common tools", () => {
    expect(describeTool("Bash", { command: "pnpm test\nmore" })).toBe("pnpm test");
    expect(describeTool("Bash", { command: "x", description: "Run the tests" })).toBe("Run the tests");
    expect(describeTool("WebFetch", { url: "https://docs.example.com/a" })).toBe("Fetching docs.example.com");
    expect(describeTool("mcp__github__create_pr", {})).toBe("github create pr");
  });
});

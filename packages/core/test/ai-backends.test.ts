import { describe, expect, it } from "vitest";
import { effortOptions } from "../src/ai/backends.ts";

describe("effort", () => {
  const openai = (model: string, effort?: "minimal" | "low") => effortOptions({ provider: "openai", model, effort })?.openai?.reasoningEffort;

  it("asks OpenAI for its least effort in the words each model takes", () => {
    expect(openai("gpt-5-mini", "minimal")).toBe("minimal");
    expect(openai("gpt-5", "minimal")).toBe("minimal");
    expect(openai("gpt-5.4-mini", "minimal")).toBe("none"); // refuses "minimal" (core.log, 2026-10-05)
    expect(openai("gpt-6", "minimal")).toBe("none");
    expect(openai("o4-mini", "minimal")).toBe("low");
    expect(openai("gpt-5.4-mini", "low")).toBe("low");
    expect(openai("gpt-4.1")).toBeUndefined();
  });

  it("takes minimal as low on Anthropic, and leaves older models alone", () => {
    expect(effortOptions({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "minimal" })).toEqual({ anthropic: { effort: "low" } });
    expect(effortOptions({ provider: "anthropic", model: "claude-haiku-4-5", effort: "minimal" })).toBeUndefined();
  });
});

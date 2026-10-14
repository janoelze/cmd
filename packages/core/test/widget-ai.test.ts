// cmd.ai.complete through the core (docs/56; widgets/api/ai.ts) over a fake AI service: text,
// and an object for a JSON Schema, with the tokens used; each call is the AI service's own
// (logged as ai.call with purpose "widget:<name>", no tools); the package's daily budget stops
// a call once spent and says where to raise it; no provider says how to set one up.

import { describe, expect, it } from "vitest";
import { AiNotConfigured } from "../src/ai/service.ts";
import { ApiRefusal } from "../src/widgets/api/access.ts";
import { AiUsage, widgetComplete, type AiScope } from "../src/widgets/api/ai.ts";
import { tmp } from "./fake-widget-runtime.ts";

const usage = { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 };

function fakeAi() {
  const calls: Record<string, unknown>[] = [];
  const ai = {
    complete: async (o: Record<string, unknown>) => (calls.push({ ...o, kind: "text" }), { value: `answer to ${o.prompt}`, usage, model: "fast" }),
    object: async (o: Record<string, unknown>) => (calls.push({ ...o, kind: "object" }), { value: { mood: "calm", score: 3 }, usage, model: "fast" }),
  } as unknown as AiScope["ai"];
  return { ai, calls };
}

const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiRefusal) return e.error;
    throw e;
  }
  throw new Error("not refused");
};

describe("ai.complete", () => {
  it("answers with text through the person's AI, no tools, as the widget's purpose", async () => {
    const { ai, calls } = fakeAi();
    const r = await widgetComplete({ prompt: "hello", system: "be brief", maxTokens: 99999 }, { name: "demo", stateDir: null, budget: () => 0, ai }, new AiUsage(null));
    expect(r).toEqual({ text: "answer to hello", usage: { input: 120, output: 30 } });
    expect(calls).toEqual([expect.objectContaining({ kind: "text", purpose: "widget:demo", prompt: "hello", system: "be brief", maxOutputTokens: 4000 })]);
    expect(calls[0]).not.toHaveProperty("tools");
  });

  it("answers with an object for a JSON Schema", async () => {
    const { ai, calls } = fakeAi();
    const schema = { type: "object", properties: { mood: { type: "string" }, score: { type: "number" } }, required: ["mood", "score"] };
    const r = await widgetComplete({ prompt: "rate it", schema }, { name: "demo", stateDir: null, budget: () => 0, ai }, new AiUsage(null));
    expect(r).toEqual({ object: { mood: "calm", score: 3 }, usage: { input: 120, output: 30 } });
    expect(calls[0]).toMatchObject({ kind: "object", schema });
  });

  it("stops a call once the package's daily budget is spent, kept across restarts", async () => {
    const { ai, calls } = fakeAi();
    const stateDir = tmp("cmd-widget-ai-");
    const scope: AiScope = { name: "demo", stateDir, budget: () => 200, ai };
    await widgetComplete({ prompt: "one" }, scope, new AiUsage(stateDir)); // 150 of 200
    await widgetComplete({ prompt: "two" }, scope, new AiUsage(stateDir)); // 300: over, but it was under when asked
    const e = await refused(widgetComplete({ prompt: "three" }, scope, new AiUsage(stateDir)));
    expect(e).toEqual({ code: "failed", message: "demo used today's AI budget (200 tokens). Raise it in Settings → Magic Widgets." });
    expect(calls).toHaveLength(2);
    // Another package has its own.
    expect(await widgetComplete({ prompt: "four" }, { ...scope, name: "other" }, new AiUsage(stateDir))).toMatchObject({ text: "answer to four" });
  });

  it("says so when no AI provider is set up", async () => {
    const ai = { complete: () => Promise.reject(new AiNotConfigured()), object: () => Promise.reject(new AiNotConfigured()) } as unknown as AiScope["ai"];
    const e = await refused(widgetComplete({ prompt: "hi" }, { name: "demo", stateDir: null, budget: () => 0, ai }, new AiUsage(null)));
    expect(e).toEqual({ code: "failed", message: "No AI provider is set up yet. Add an API key in Settings → AI." });
  });

  it("refuses a request without a prompt", async () => {
    const { ai } = fakeAi();
    expect((await refused(widgetComplete({ prompt: " " }, { name: "demo", stateDir: null, budget: () => 0, ai }, new AiUsage(null)))).code).toBe("invalid");
  });
});

// Live Code's core parts: the window type (its code is its state) and the AI
// request (livecode/change.ts): what the model is sent and what comes back.

import { describe, expect, it } from "vitest";
import { changeCode, changePrompt, changeSystem, soundList } from "../src/livecode/change.ts";
import { LIVECODE_STARTER, livecodeType } from "../src/windows/builtin.ts";

describe("livecode window", () => {
  it("starts with code that plays, and keeps what it's given", () => {
    expect(livecodeType.create({}).state.code).toBe(LIVECODE_STARTER);
    const { state } = livecodeType.create({ code: 's("bd")' });
    expect(livecodeType.update!(state, { code: 's("sd")' }).state).toEqual({ code: 's("sd")' });
    expect(livecodeType.update!(state, { code: 3 }).state).toEqual({ code: 's("bd")' });
  });
});

describe("livecode change", () => {
  it("sends the prompt and Strudel's reference as one cached system prompt", () => {
    const system = changeSystem();
    expect(system).toContain("You change the code of a live-coded piece of music");
    expect(system).toContain("## lpf(frequency) [cutoff, ctf, lp]");
    expect(system.length).toBeGreaterThan(50_000);
  });

  it("lists sounds by bank", () => {
    expect(soundList(["sawtooth", "piano", "RolandTR909_bd", "RolandTR909_hh", "bd"])).toBe("sawtooth piano bd\nRolandTR909: bd hh");
  });

  it("asks with the code, the sounds and the last failure", () => {
    const p = changePrompt({ code: 's("bd")', request: "more hats", sounds: ["hh"], failed: { code: "x", error: "x is not defined" } });
    expect(p).toContain("Request: more hats");
    expect(p).toContain('s("bd")');
    expect(p).toContain("Error: x is not defined");
    expect(p).toContain("hh");
  });

  it("returns the model's code without a fence, and its summary", async () => {
    const calls: Record<string, unknown>[] = [];
    const object = (async (o: Record<string, unknown>) => {
      calls.push(o);
      return { value: { code: '```js\ns("bd*2")\n```', summary: " Doubled the kick " }, usage: { input: 0, output: 0 }, model: "m" };
    }) as never;
    expect(await changeCode(object, { code: 's("bd")', request: "double the kick" })).toEqual({ code: 's("bd*2")', summary: "Doubled the kick" });
    expect(calls[0]).toMatchObject({ purpose: "livecode.change", cacheSystem: true });
  });

  it("refuses an empty request", async () => {
    await expect(changeCode((async () => ({})) as never, { code: "", request: "  " })).rejects.toThrow("Say what to change");
  });
});

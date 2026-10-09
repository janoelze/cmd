// Live Code's core parts: the window type (its code is its state) and the AI
// request (livecode/change.ts): what the model is sent and what comes back.

import { describe, expect, it } from "vitest";
import { applyEdits, changeCode, changePrompt, changeSystem, soundList } from "../src/livecode/change.ts";
import { LIVECODE_STARTER, livecodeType } from "../src/windows/builtin.ts";

describe("livecode window", () => {
  it("starts with code that plays, and keeps what it's given", () => {
    expect(livecodeType.create({}).state.code).toBe(LIVECODE_STARTER);
    const { state } = livecodeType.create({ code: 's("bd")' });
    expect(livecodeType.update!(state, { code: 's("sd")' }).state).toEqual({ code: 's("sd")', versions: [] });
    expect(livecodeType.update!(state, { code: 3 }).state).toEqual({ code: 's("bd")', versions: [] });
  });

  it("keeps its last ten versions, well-formed ones only", () => {
    const { state } = livecodeType.create({});
    const v = (i: number) => ({ code: `s("bd*${i}")`, request: `r${i}`, summary: `s${i}`, extra: 1 });
    const next = livecodeType.update!(state, { versions: [...Array.from({ length: 12 }, (_, i) => v(i)), { code: 1 }] }).state;
    expect(next.versions).toHaveLength(10);
    expect(next.versions[0]).toEqual({ code: 's("bd*0")', request: "r0", summary: "s0" });
  });
});

describe("livecode change", () => {
  it("sends the prompt and Strudel's reference as one cached system prompt", () => {
    const system = changeSystem();
    expect(system).toContain("You change the code of a live-coded piece of music");
    expect(system).toContain("## lpf(frequency) [cutoff, ctf, lp]");
    expect(system).toContain("## Drum & bass");
    expect(system).toContain("`breaks165`");
    expect(system).toContain("## Mixing rules");
    expect(system).toContain("breaks152 (1): loop 4.70s = 3.0 bars at 152 BPM");
    expect(system.length).toBeGreaterThan(50_000);
  });

  it("lists sounds by bank", () => {
    expect(soundList(["sawtooth", "piano", "RolandTR909_bd", "RolandTR909_hh", "bd"])).toBe("sawtooth piano bd\nRolandTR909: bd hh");
  });

  it("shows the model earlier versions, newest first, for undo", () => {
    const history = Array.from({ length: 7 }, (_, i) => ({ code: `v${i}`, request: `req${i}`, summary: `sum${i}` }));
    const p = changePrompt({ code: "now", request: "undo the last two changes", history });
    expect(p).toContain('1. "req0" (sum0). Before it:\n```\nv0\n```');
    expect(p).toContain('5. "req4"');
    expect(p).not.toContain("req5");
  });

  it("asks with the code, the sounds and the last failure", () => {
    const p = changePrompt({ code: 's("bd")', request: "more hats", sounds: ["hh", "sawtooth", "mysample"], failed: { code: "x", error: "x is not defined" } });
    expect(p).toContain("Request: more hats");
    expect(p).toContain('s("bd")');
    expect(p).toContain("Error: x is not defined");
    // The atlas (system prompt) has hh, and sawtooth is a synth: only what it lacks is listed.
    expect(p).toContain("Also loaded:\nmysample");
    expect(p).not.toContain("hh");
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

  it("applies edits, and says which one doesn't fit", () => {
    const code = 'stack(\n  s("bd*4"),\n  s("hh*8").gain(.5),\n)';
    expect(applyEdits(code, [{ find: 's("hh*8")', replace: 's("hh*16")' }])).toBe('stack(\n  s("bd*4"),\n  s("hh*16").gain(.5),\n)');
    expect(() => applyEdits(code, [{ find: "sd", replace: "cp" }])).toThrow('Edit 1 (find "sd"): not in the code');
    expect(() => applyEdits(code, [{ find: "s(", replace: "n(" }])).toThrow("occurs more than once");
  });

  it("answers with edits applied, and sends edits that don't fit back once", async () => {
    const answers = [
      { summary: "More hats", edits: [{ find: "hh*4", replace: "hh*8" }], code: "" },
      { summary: "More hats", edits: [{ find: 's("hh")', replace: 's("hh*2")' }], code: "" },
    ];
    const prompts: string[] = [];
    const object = (async (o: { prompt: string }) => (prompts.push(o.prompt), { value: answers.shift(), usage: { input: 0, output: 0 }, model: "m" })) as never;
    expect(await changeCode(object, { code: 's("hh")', request: "more hats" })).toEqual({ code: 's("hh*2")', summary: "More hats" });
    expect(prompts[1]).toContain("not in the code");
  });

  it("refuses an empty request", async () => {
    await expect(changeCode((async () => ({})) as never, { code: "", request: "  " })).rejects.toThrow("Say what to change");
  });
});

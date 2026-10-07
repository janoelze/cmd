import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Agent, type AgentTurn } from "@cmd/protocol";
import { AgentNaming } from "../src/agents/naming.ts";
import { checkName, decide, mightHaveChanged, nameInput, NO_NAME, shouldAsk, type NamerAnswer, type NamerTurn } from "../src/agents/namer.ts";
import { replay, sameName, scoreCase, summarize, type Ask, type NameCase } from "../src/agents/names-eval.ts";

const MIN = 60_000;
const turn = (at: number, prompt: string, files: string[] = []): NamerTurn => ({ at: at * MIN, prompt, files });

describe("checking a proposed name", () => {
  it("takes 1–3 nouns and cleans quotes and case", () => {
    expect(checkName("“tours”")).toEqual({ name: "Tours", problem: null });
    expect(checkName("Slow release CI")).toEqual({ name: "Slow release CI", problem: null });
    expect(checkName("null")).toEqual({ name: null, problem: null });
  });

  it("refuses verbs, long names and a name another agent has", () => {
    expect(checkName("Fix icon sizes").problem).toMatch(/verb/);
    expect(checkName("Notification permission settings UI").problem).toMatch(/3 words/);
    expect(checkName("Tours", ["tours"]).problem).toMatch(/another agent/);
    expect(checkName("V0.17.1").problem).toMatch(/version/);
    expect(checkName("Cmd data model", [], "cmd").problem).toMatch(/project/);
    expect(checkName("Notarize once").problem).toMatch(/verb/);
    for (const thing of ["Show posters", "Release CI", "Build cache", "Hook design"]) expect(checkName(thing).problem).toBeNull();
  });
});

describe("when to ask", () => {
  it("asks for a first name until it has one, a few times", () => {
    expect(shouldAsk(NO_NAME, [turn(0, "hi")])).toBe("first name");
    expect(shouldAsk({ ...NO_NAME, tries: 6 }, [turn(0, "hi")])).toBeNull();
  });

  it("doesn't ask while the prompts stay on the thing", () => {
    const ts = [turn(0, "the release CI takes 20 minutes, why?"), turn(5, "yes, do it"), turn(9, "cache the release build in CI too")];
    expect(mightHaveChanged("Slow release CI", ts.slice(0, 2))).toBeNull();
    expect(mightHaveChanged("Slow release CI", ts)).toBeNull();
  });

  it("asks on new words or new folders; after a quiet, fewer new words do", () => {
    const base = [turn(0, "the release CI takes 20 minutes, why?", ["/r/.github/release.yml"])];
    expect(mightHaveChanged("Slow release CI", [...base, turn(5, "now record marketing videos with scripted tours")])).toBe("new words");
    expect(mightHaveChanged("Slow release CI", [...base, turn(5, "release CI again", ["/r/packages/tours/a.ts"])])).toBe("new folders");
    expect(mightHaveChanged("Slow release CI", [...base, turn(50, "release CI")])).toBeNull();
    expect(mightHaveChanged("Slow release CI", [...base, turn(50, "torrent posters")])).toBe("new words after a quiet");
    expect(mightHaveChanged("Slow release CI", [...base, turn(5, "torrent posters")])).toBeNull();
  });
});

describe("taking a proposed name", () => {
  const named = { ...NO_NAME, name: "Accessibility audit" };
  const change = (name: string): NamerAnswer => ({ intent: "change", name });

  it("renames after two changes in a row, or one with a hard signal", () => {
    const once = decide(named, change("Tours"), 1);
    expect(once).toMatchObject({ name: "Accessibility audit", pending: "Tours" });
    expect(decide(once, change("Tours"), 2)).toMatchObject({ name: "Tours", history: [{ name: "Accessibility audit", until: 2 }] });
    expect(decide(named, change("Tours"), 1, true).name).toBe("Tours");
  });

  it("waits while two changes in a row disagree on the name", () => {
    const once = decide(named, change("Missing posters"), 1);
    const twice = decide(once, change("Downloads"), 2);
    expect(twice).toMatchObject({ name: "Accessibility audit", pending: "Downloads" });
    expect(decide(once, change("Poster cleanup"), 2).name).toBe("Poster cleanup");
  });

  it("forgets a single change, and never goes back to a name it just left", () => {
    expect(decide(decide(named, change("Tours"), 1), { intent: "develop", name: null }, 2)).toMatchObject({ name: "Accessibility audit", pending: null });
    const moved = { ...NO_NAME, name: "Tours", history: [{ name: "Accessibility audit", until: 0 }] };
    expect(decide(moved, change("Accessibility audit"), 10 * MIN, true).name).toBe("Tours");
  });
});

describe("the prompt", () => {
  it("has the current name, the others, earlier prompts and the newest turn, with the start of pastes", () => {
    const text = nameInput({ current: "Tours", others: ["Icon sizes"], turns: [turn(0, "record tours"), { ...turn(1, "<pasted_content id=x>secret</pasted_content> and fix the cursor", ["/r/packages/tours/cursor.ts"]), final: "Cursor fixed." }] });
    expect(text).toContain("<current>Tours</current>");
    expect(text).toContain("<others>Icon sizes</others>");
    expect(text).toContain("- record tours");
    expect(text).toContain("<newest>[pasted: secret] and fix the cursor</newest>");
    expect(text).toContain("<files>cursor.ts</files>");
  });
});

describe("replaying a session", () => {
  /** A model that answers from a script: per newest prompt, the answer. */
  const scripted = (answers: Record<string, NamerAnswer>): Ask => async (input) => answers[input.turns.at(-1)!.prompt] ?? { intent: "continue", name: null };

  const drift: NameCase = {
    id: "drift",
    turns: [
      turn(0, "audit the app for accessible names"),
      turn(5, "also the toolbar fields"),
      turn(10, "now record marketing videos with scripted tours"),
      turn(15, "the cursor in the tour video lags behind"),
      turn(20, "yes"),
    ],
    expect: { final: ["Tours"] },
  };

  it("names at the first prompt, follows a change confirmed by the next turn, and asks only when the checks fire", async () => {
    const r = await replay(drift, scripted({
      "audit the app for accessible names": { intent: "continue", name: "Accessibility audit" },
      "now record marketing videos with scripted tours": { intent: "change", name: "Tours" },
      "the cursor in the tour video lags behind": { intent: "change", name: "Tours" },
    }));
    expect(r.steps.map((s) => `${s.turn + 1} ${s.at}: ${s.why ?? "-"} = ${s.name}`)).toEqual([
      "1 prompt: first name = Accessibility audit",
      "1 end: - = Accessibility audit",
      "2 end: - = Accessibility audit",
      "3 end: new words = Accessibility audit",
      "4 end: pending change = Tours",
      "5 end: - = Tours",
    ]);
    const s = scoreCase(drift, r);
    expect(s).toMatchObject({ final: "Tours", renames: 1, match: 1, calls: 3, firstAt: { turn: 0, at: "prompt" } });
    expect(summarize([s])).toMatchObject({ cases: 1, named: 1, atFirstPrompt: 1, match: 1, callsPerTurn: 3 / 5 });
  });

  it("tries again at the turn's end when the prompt alone gives nothing to name", async () => {
    const c: NameCase = { id: "late", turns: [{ ...turn(0, "read a few files"), files: ["/r/packages/tours/a.ts"], final: "The tours package records demo videos." }] };
    const r = await replay(c, async (input) => ({ intent: "change", name: input.turns.at(-1)!.final ? "Tours" : null }));
    expect(scoreCase(c, r)).toMatchObject({ final: "Tours", calls: 2, firstAt: { turn: 0, at: "end" } });
  });

  it("asks again once when a proposal breaks the rules, then keeps nothing", async () => {
    let n = 0;
    const r = await replay({ id: "verb", turns: [turn(0, "fix the icons")] }, async (input) => (n++, { intent: "continue", name: input.rejected ? "Icon sizes" : "Fix icon sizes" }));
    expect(r.state.name).toBe("Icon sizes");
    expect(r.steps[0]!.problem).toMatch(/verb/);
    expect(n).toBe(2);
  });

  it("scores a session that shouldn't be named", async () => {
    const c: NameCase = { id: "hi", turns: [turn(0, "hi")], expect: { none: true } };
    expect(scoreCase(c, await replay(c, scripted({}))).match).toBe(1);
  });

  it("compares names loosely", () => {
    expect(sameName("Release CI", "Slow release CI")).toBe(true);
    expect(sameName("Tours", "Icon sizes")).toBe(false);
  });
});

describe("naming live agents", () => {
  const t = (index: number, prompt: string, over: Partial<AgentTurn> = {}): AgentTurn => ({ format: 2, derivedBy: null, agentId: "a1", agentKind: "claude", agentVersion: null, model: null, index, sessionId: "s1", turnId: null, startedAt: index * 5 * MIN, endedAt: index * 5 * MIN + 1000, prompt, auto: false, followUps: [], notes: [], background: [], outcome: "done", ask: null, final: null, error: null, tools: [], commands: [], shellWrites: 0, files: [], subagents: 0, events: 1, inferred: [], ...over });
  const setup = (answers: Record<string, NamerAnswer>, agent: Partial<Agent> = {}) => {
    const turns: AgentTurn[] = [];
    const asked: string[] = [];
    const a = { id: "a1", spaceId: "s", kind: "claude", name: null, nameBy: null, depth: 0, ...agent } as Agent;
    const naming = new AgentNaming({
      ai: { ready: () => true, object: async <T,>(o: { prompt: string }) => (asked.push(o.prompt), { value: (answers[/<newest>(.*)<\/newest>/.exec(o.prompt)![1]!] ?? { intent: "continue", name: null }) as T }) as never },
      settings: () => ({ ...DEFAULT_SETTINGS }),
      agents: () => [a],
      turns: () => turns,
      name: (_id, name) => ((a.name = name), (a.nameBy = "model"), true),
    });
    const end = async (turn: AgentTurn) => {
      turns.push(turn);
      naming.updated({ ...a, turn });
      await naming.settled("a1");
    };
    return { a, asked, end };
  };

  it("names after the first turn and asks again only when the checks fire", async () => {
    const { a, asked, end } = setup({ "the release CI takes 20 minutes, why?": { intent: "continue", name: "Slow release CI" } });
    await end(t(0, "the release CI takes 20 minutes, why?"));
    expect(a.name).toBe("Slow release CI");
    await end(t(1, "cache the release build in CI then"));
    expect(asked).toHaveLength(1);
  });

  it("names at the prompt, before the turn ends, and doesn't ask again at its end", async () => {
    const { a, asked, end } = setup({ "the release CI takes 20 minutes, why?": { intent: "change", name: "Slow release CI" } });
    await end(t(0, "the release CI takes 20 minutes, why?", { endedAt: null }));
    expect(a.name).toBe("Slow release CI");
    await end(t(0, "the release CI takes 20 minutes, why?"));
    expect(asked).toHaveLength(1);
  });

  it("asks again at the turn's end when the prompt gave nothing to name", async () => {
    const { a, asked, end } = setup({});
    await end(t(0, "read a few files", { endedAt: null }));
    expect(a.name).toBeNull();
    await end(t(0, "read a few files"));
    expect(asked).toHaveLength(2);
  });

  it("names a new session (after a /clear) afresh, from its own turns", async () => {
    const { a, asked, end } = setup({ "the release CI takes 20 minutes, why?": { intent: "continue", name: "Slow release CI" }, "icons are too small on retina": { intent: "continue", name: "Icon sizes" } });
    await end(t(0, "the release CI takes 20 minutes, why?"));
    await end(t(1, "icons are too small on retina", { sessionId: "s2" }));
    expect(a.name).toBe("Icon sizes");
    expect(asked[1]).not.toContain("release CI");
  });

  it("leaves agents a person or a worktree named", async () => {
    for (const nameBy of ["user", "worktree"] as const) {
      const { a, asked, end } = setup({}, { name: "Mine", nameBy });
      await end(t(0, "something else entirely now"));
      expect([a.name, asked.length]).toEqual(["Mine", 0]);
    }
  });
});

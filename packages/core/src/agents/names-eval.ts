// Measuring the namer (docs/32-session-names.md, "Measuring it"): a session's
// turns replayed through it as the live core would run it (cheap checks, the
// model's answers, hysteresis), and a score for the names it gave. The model is
// a function, so tests answer from a script and scripts/evals/names.ts from a
// real provider. Deterministic given the answers.

import { checkName, decide, nameInput, NO_NAME, sameName, shouldAsk, type NameState, type NamerAnswer, type NamerInput, type NamerTurn } from "./namer.ts";

/** One session to name, and what a good result is. */
export interface NameCase {
  /** The session's key or a label. */
  id: string;
  turns: NamerTurn[];
  /** Names of agents that ran beside it, if known. */
  others?: string[];
  /** The project's folder name. */
  project?: string | null;
  expect?: {
    /** Acceptable final names (any one, compared loosely: same words or a shared one). */
    final?: string[];
    /** Nothing in it is worth a name. */
    none?: boolean;
    /** At most this many renames (default 2). */
    maxRenames?: number;
  };
}

export { sameName };

export type Ask = (input: NamerInput & { rejected?: string }) => Promise<NamerAnswer | null>;

export interface Step {
  turn: number;
  why: string | null;
  answer: NamerAnswer | null;
  problem: string | null;
  name: string | null;
}

/** Replays a case's turns through the namer; one entry per turn. */
export async function replay(c: NameCase, ask: Ask): Promise<{ steps: Step[]; state: NameState; calls: number }> {
  let s: NameState = NO_NAME;
  let calls = 0;
  const steps: Step[] = [];
  for (let i = 0; i < c.turns.length; i++) {
    const turns = c.turns.slice(0, i + 1);
    const why = shouldAsk(s, turns);
    let answer: NamerAnswer | null = null;
    let problem: string | null = null;
    if (why) {
      const input: NamerInput = { current: s.name, turns, others: c.others ?? [], project: c.project ?? null };
      calls++;
      answer = await ask(input);
      let checked = checkName(answer?.name, input.others, input.project);
      // One more try with what was wrong, then nothing rather than a bad name.
      if (checked.problem) {
        calls++;
        problem = `${checked.name}: ${checked.problem}`;
        answer = await ask({ ...input, rejected: problem });
        checked = checkName(answer?.name, input.others, input.project);
        if (checked.problem) problem += `; then ${checked.name}: ${checked.problem}`;
      }
      answer = answer ? { ...answer, name: checked.problem ? null : checked.name } : null;
    }
    s = why ? decide(s, answer, c.turns[i]!.at) : s;
    steps.push({ turn: i, why, answer, problem, name: s.name });
  }
  return { steps, state: s, calls };
}

/** The input text with a rejected proposal, for providers (the eval's and the core's). */
export function askText(input: NamerInput & { rejected?: string }): string {
  return nameInput(input) + (input.rejected ? `\n<rejected>${input.rejected}. Answer again.</rejected>` : "");
}

export interface CaseScore {
  id: string;
  final: string | null;
  names: string[];
  renames: number;
  calls: number;
  turns: number;
  problems: number;
  /** 1 when the final name is acceptable (or rightly none), 0 when not; null without an expectation. */
  match: number | null;
  issues: string[];
}

export function scoreCase(c: NameCase, r: Awaited<ReturnType<typeof replay>>): CaseScore {
  const names: string[] = [];
  for (const st of r.steps) if (st.name && st.name !== names.at(-1)) names.push(st.name);
  const final = r.state.name;
  const renames = Math.max(0, names.length - 1);
  const issues: string[] = [];
  let match: number | null = null;
  if (c.expect?.none) match = final ? 0 : 1;
  else if (c.expect?.final?.length) match = final && c.expect.final.some((e) => sameName(final, e)) ? 1 : 0;
  if (match === 0) issues.push(`named ${final ?? "nothing"}, wanted ${c.expect?.none ? "none" : c.expect!.final!.join(" / ")}`);
  if (renames > (c.expect?.maxRenames ?? 2)) issues.push(`${renames} renames: ${names.join(" → ")}`);
  const problems = r.steps.filter((s) => s.problem).length;
  for (const s of r.steps.filter((s) => s.problem)) issues.push(`turn ${s.turn + 1}: ${s.problem}`);
  return { id: c.id, final, names, renames, calls: r.calls, turns: c.turns.length, problems, match, issues };
}

export interface Summary {
  cases: number;
  /** Mean match over cases with an expectation. */
  match: number | null;
  named: number;
  renames: { mean: number; max: number; over2: number };
  /** Model calls per turn: what naming costs. */
  callsPerTurn: number;
  problems: number;
}

export function summarize(scores: CaseScore[]): Summary {
  const judged = scores.filter((s) => s.match !== null);
  const turns = scores.reduce((n, s) => n + s.turns, 0);
  return {
    cases: scores.length,
    match: judged.length ? judged.reduce((n, s) => n + s.match!, 0) / judged.length : null,
    named: scores.filter((s) => s.final).length,
    renames: { mean: scores.reduce((n, s) => n + s.renames, 0) / (scores.length || 1), max: Math.max(0, ...scores.map((s) => s.renames)), over2: scores.filter((s) => s.renames > 2).length },
    callsPerTurn: turns ? scores.reduce((n, s) => n + s.calls, 0) / turns : 0,
    problems: scores.reduce((n, s) => n + s.problems, 0),
  };
}

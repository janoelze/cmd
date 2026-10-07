// Names agents with the fast tier as their turns end (docs/32-session-names.md,
// steps 3–4): the namer's rules (namer.ts) run live, the same way the eval
// replays them. Only agents nobody named: a person's name and a worktree's
// branch both win over a model's. A turn is asked about only when the cheap
// checks fire; one question per agent at a time; a failed call names nothing.

import type { Agent, AgentId, AgentTurn, Settings } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { CallOptions } from "../ai/service.ts";
import type { CompleteResult, ObjectRequest } from "../ai/backends.ts";
import { buildContext } from "../ai/context.ts";
import { askText } from "./names-eval.ts";
import { checkName, decide, NAME_SCHEMA, nameSystem, NO_NAME, shouldAsk, FIRST_TRIES, type NameState, type NamerAnswer, type NamerTurn } from "./namer.ts";

const log = logger("names");

export interface NamingOptions {
  ai: { object<T>(o: CallOptions & ObjectRequest<T>): Promise<CompleteResult<T>>; ready(): boolean };
  settings: () => Settings;
  agents: () => Agent[];
  /** An agent's turns, oldest first. */
  turns: (id: AgentId) => AgentTurn[];
  /** Gives the name; refuses (false) when the person or a worktree named it meanwhile. */
  name: (id: AgentId, name: string, why: string) => boolean;
}

/** A turn as the namer reads it; null for turns that aren't the person's (a background task's). */
export function namerTurn(t: AgentTurn): NamerTurn | null {
  if (t.auto || !t.prompt?.trim()) return null;
  const prompt = [t.prompt, ...t.followUps].join("\n");
  return { at: t.startedAt, prompt, files: t.files.map((f) => f.path), final: t.final };
}

export class AgentNaming {
  #o: NamingOptions;
  #state = new Map<AgentId, NameState>();
  /** The last turn each agent was looked at for. */
  #seen = new Map<AgentId, number>();
  /** Agents being named now, until the answer is in. */
  #busy = new Map<AgentId, Promise<void>>();

  constructor(o: NamingOptions) {
    this.#o = o;
  }

  /** An agent changed: if a turn of it just ended, maybe name it. */
  updated(a: Agent): void {
    const t = a.turn;
    if (!t || t.endedAt === null || this.#seen.get(a.id) === t.index || this.#busy.has(a.id)) return;
    if (a.depth > 0 || a.nameBy === "user" || a.nameBy === "worktree") return;
    if (!this.#o.settings()["agents.names.ai"] || !this.#o.ai.ready()) return;
    this.#seen.set(a.id, t.index);
    const run = this.#turnEnded(a)
      .catch((err) => log.warn(`naming ${a.id.slice(0, 8)} failed: ${(err as Error).message}`))
      .finally(() => this.#busy.delete(a.id));
    this.#busy.set(a.id, run);
  }

  /** Resolves once a name being decided for the agent is in (at once when none is): its notification waits for it. */
  settled(id: AgentId): Promise<void> {
    return this.#busy.get(id) ?? Promise.resolve();
  }

  removed(id: AgentId): void {
    this.#state.delete(id);
    this.#seen.delete(id);
  }

  async #turnEnded(a: Agent): Promise<void> {
    const turns = this.#o.turns(a.id).map(namerTurn).filter((t): t is NamerTurn => !!t).slice(-20);
    if (!turns.length) return;
    // After a restart: what the agent already has stands in for the remembered state.
    const s = this.#state.get(a.id) ?? (a.name ? { ...NO_NAME, name: a.name, tries: FIRST_TRIES, history: a.nameWas ? [{ name: a.nameWas, until: a.namedAt ?? 0 }] : [] } : NO_NAME);
    const why = shouldAsk(s, turns);
    if (!why) return void this.#state.set(a.id, s);
    const others = this.#o.agents().filter((x) => x.id !== a.id && x.spaceId === a.spaceId && x.name).map((x) => x.name!);
    const input = { current: s.name, turns, others };
    let answer = await this.#ask(askText(input));
    let checked = checkName(answer?.name, others);
    if (checked.problem) {
      answer = await this.#ask(askText({ ...input, rejected: `${checked.name}: ${checked.problem}` }));
      checked = checkName(answer?.name, others);
    }
    const next = decide(s, answer ? { ...answer, name: checked.problem ? null : checked.name } : null, turns.at(-1)!.at);
    this.#state.set(a.id, next);
    if (next.name && next.name !== a.name && !this.#o.name(a.id, next.name, `${why}: ${answer?.intent ?? "first"}`)) this.#state.delete(a.id);
  }

  async #ask(prompt: string): Promise<NamerAnswer | null> {
    const ctx = buildContext({ purpose: "session.name", budget: 6000, parts: [{ name: "session", text: prompt }] });
    const res = await this.#o.ai.object<NamerAnswer>({ tier: "fast", purpose: "session.name", system: nameSystem(), prompt: ctx.text, schema: NAME_SCHEMA as unknown as Record<string, unknown>, effort: "minimal", maxOutputTokens: 300, context: ctx.record });
    return res.value;
  }
}

// Names agents with the fast tier (docs/32-session-names.md, steps 3–4): the
// namer's rules (namer.ts) run live, the same way the eval replays them. While
// an agent has no name, it's asked as soon as a prompt arrives (the prompt
// alone often says enough), and again when the turn ends (with what it wrote
// and said); once named, at turn ends when the cheap checks fire. Only agents
// nobody named: a person's name and a worktree's branch both win over a
// model's. One question per agent at a time, in order; a failed call names nothing.

import path from "node:path";
import type { Agent, AgentId, AgentTurn, Settings } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { CallOptions } from "../ai/service.ts";
import type { CompleteResult, ObjectRequest } from "../ai/backends.ts";
import { buildContext } from "../ai/context.ts";
import { projectOf } from "../data/project.ts";
import { askText } from "./names-eval.ts";
import { askChecked, atPrompt, decide, NAME_SCHEMA, nameSystem, NO_NAME, shouldAsk, FIRST_TRIES, type NameState, type NamerAnswer, type NamerTurn } from "./namer.ts";

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

type Moment = "prompt" | "end";

export class AgentNaming {
  #o: NamingOptions;
  #state = new Map<AgentId, NameState & { session: string | null }>();
  /** Per agent, the turn moments already looked at ("3 prompt", "3 end"). */
  #seen = new Map<AgentId, string>();
  /** Per agent, the questions queued or running: one at a time, in order. */
  #busy = new Map<AgentId, Promise<void>>();

  constructor(o: NamingOptions) {
    this.#o = o;
  }

  /** An agent changed: a prompt arrived while it has no name, or a turn ended: maybe name it. */
  updated(a: Agent): void {
    const t = a.turn;
    if (!t || a.depth > 0 || a.nameBy === "user" || a.nameBy === "worktree") return;
    const moment: Moment | null = t.endedAt !== null ? "end" : !a.name && !t.auto && t.prompt?.trim() ? "prompt" : null;
    const key = `${t.index} ${moment}`;
    if (!moment || this.#seen.get(a.id) === key || (moment === "prompt" && this.#seen.get(a.id) === `${t.index} end`)) return;
    if (!this.#o.settings()["agents.names.ai"] || !this.#o.ai.ready()) return;
    this.#seen.set(a.id, key);
    const run = (this.#busy.get(a.id) ?? Promise.resolve())
      .then(() => this.#name(a.id, t, moment))
      .catch((err) => log.warn(`naming ${a.id.slice(0, 8)} failed: ${(err as Error).message}`));
    this.#busy.set(a.id, run);
    void run.finally(() => this.#busy.get(a.id) === run && this.#busy.delete(a.id));
  }

  /** Resolves once a name being decided for the agent is in (at once when none is): its notification waits for it. */
  settled(id: AgentId): Promise<void> {
    return this.#busy.get(id) ?? Promise.resolve();
  }

  removed(id: AgentId): void {
    this.#state.delete(id);
    this.#seen.delete(id);
  }

  async #name(id: AgentId, t: AgentTurn, moment: Moment): Promise<void> {
    // As it is now: an earlier question may have named it, or the person did meanwhile.
    const a = this.#o.agents().find((x) => x.id === id);
    if (!a || a.nameBy === "user" || a.nameBy === "worktree") return;
    // This session's turns only: after a /clear the agent works on something new, and gets a name for it.
    const session = t.sessionId;
    const past = this.#o.turns(id).filter((x) => x.sessionId === session && x.index < t.index);
    const now = namerTurn(t);
    const turns = [...past.map(namerTurn), now && (moment === "prompt" ? atPrompt(now) : now)].filter((x): x is NamerTurn => !!x).slice(-20);
    if (!turns.length) return;
    const known = this.#state.get(id);
    // After a restart: what the agent already has stands in for the remembered state.
    const s: NameState = known?.session === session ? known : !known && a.name ? { ...NO_NAME, name: a.name, tries: FIRST_TRIES, history: a.nameWas ? [{ name: a.nameWas, until: a.namedAt ?? 0 }] : [] } : NO_NAME;
    const why = moment === "prompt" ? (s.name || s.tries >= FIRST_TRIES ? null : "first name, at the prompt") : shouldAsk(s, turns);
    if (!why) return void this.#state.set(id, { ...s, session });
    const others = this.#o.agents().filter((x) => x.id !== id && x.workspaceId === a.workspaceId && x.name).map((x) => x.name!);
    const { answer } = await askChecked((input) => this.#ask(askText(input)), { current: s.name, turns, others, project: path.basename(projectOf(a.cwd) ?? "") || null });
    const next = decide(s, answer, turns.at(-1)!.at);
    this.#state.set(id, { ...next, session });
    if (next.name && next.name !== a.name && !this.#o.name(id, next.name, `${why}: ${answer?.intent ?? "first"}`)) this.#state.delete(id);
  }

  async #ask(prompt: string): Promise<NamerAnswer | null> {
    const ctx = buildContext({ purpose: "session.name", budget: 6000, parts: [{ name: "session", text: prompt }] });
    const res = await this.#o.ai.object<NamerAnswer>({ tier: "fast", purpose: "session.name", system: nameSystem(), prompt: ctx.text, schema: NAME_SCHEMA as unknown as Record<string, unknown>, effort: "minimal", maxOutputTokens: 300, temperature: 0, context: ctx.record });
    return res.value;
  }
}

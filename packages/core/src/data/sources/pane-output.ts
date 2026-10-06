// What agents' panes print (docs/28 §2, requirement A7), recorded two ways:
// - `pane.activity`: stretches of output (at → until). The reducer's timing rules
//   read terminal activity (quiet for 30 s ends a turn, output after a question
//   means it was answered), so a rebuild needs it to give the turns the live
//   core gave (ActivityView.rebuild). A new stretch starts after a second of
//   quiet; the open one is saved every couple of seconds, not on every chunk.
// - `agent.output`: what a turn left on the screen, once it ends: the pane's
//   rendered lines (the PTY host's terminal) from the prompt's echo on, without
//   the agent's input box. Not the raw stream: a TUI draws with cursor moves,
//   and stripped of them its words run together.
// Only panes running an agent: plain terminals' output is their commands'.

import type { AgentTurn, PaneId } from "@cmd/protocol";
import type { PaneManager } from "../../panes.ts";
import type { DataService } from "../service.ts";
import type { ActivityView } from "../views/activity.ts";

/** Quiet longer than this starts a new stretch. */
export const STRETCH_GAP_MS = 1000;
/** The open stretch is saved this often. */
const SAVE_EVERY_MS = 2000;
/** Rendered lines read when a turn ends (the class cap cuts what's recorded further). */
const TURN_LINES = 1000;
/** Without the prompt's echo on screen (an auto turn, a cleared screen): this many last lines. */
const FALLBACK_LINES = 200;

interface Stretch {
  id: string;
  at: number;
  last: number;
  saved: number;
}

export class PaneOutputRecorder {
  #data: DataService;
  #panes: PaneManager;
  #stretch = new Map<PaneId, Stretch>();
  #written = new Set<string>();
  #timer: ReturnType<typeof setInterval>;
  #paneOf: (agentId: string) => PaneId | null;
  #settleMs: number;
  #disposed = false;

  /** `settleMs`: how long after a turn ends its screen is read (the final answer is drawn after the Stop event). */
  constructor(o: { data: DataService; panes: PaneManager; activity: ActivityView; paneOf: (agentId: string) => PaneId | null; settleMs?: number }) {
    this.#data = o.data;
    this.#panes = o.panes;
    this.#paneOf = o.paneOf;
    this.#settleMs = o.settleMs ?? 1500;
    o.panes.on("output", this.#onOutput);
    o.panes.on("removed", this.#onRemoved);
    o.activity.onTurn((t) => this.#turn(t));
    this.#timer = setInterval(() => this.#saveOpen(), SAVE_EVERY_MS);
    this.#timer.unref?.();
  }

  #onOutput = (id: PaneId) => this.#output(id);
  #onRemoved = (id: PaneId) => this.#close(id);

  /** Saves the open stretches and stops listening: terminals keep printing while the core shuts down. */
  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#timer);
    this.#panes.off("output", this.#onOutput);
    this.#panes.off("removed", this.#onRemoved);
    for (const id of [...this.#stretch.keys()]) this.#close(id);
  }

  #output(id: PaneId, now = Date.now()): void {
    const pane = this.#panes.get(id);
    if (!pane?.agentId) return;
    const s = this.#stretch.get(id);
    if (s && now - s.last <= STRETCH_GAP_MS) s.last = now;
    else {
      if (s) this.#close(id);
      const n: Stretch = { id: `activity:${id}:${now}`, at: now, last: now, saved: 0 };
      this.#stretch.set(id, n);
      this.#save(id, n);
    }
  }

  #save(id: PaneId, s: Stretch): void {
    const pane = this.#panes.get(id);
    s.saved = s.last;
    this.#data.record({ id: s.id, at: s.at, until: s.last, type: "pane.activity", source: "pty", paneId: id, agentId: pane?.agentId ?? null, spaceId: pane?.spaceId ?? null, data: {} });
  }

  #close(id: PaneId): void {
    const s = this.#stretch.get(id);
    if (!s) return;
    this.#stretch.delete(id);
    if (s.last !== s.saved) this.#save(id, s);
  }

  /** Stretches that went quiet are closed; open ones get their end saved. */
  #saveOpen(now = Date.now()): void {
    for (const [id, s] of this.#stretch) {
      if (now - s.last > STRETCH_GAP_MS) this.#close(id);
      else if (s.last !== s.saved) this.#save(id, s);
    }
  }

  /** A turn that ended: what it left on its pane's screen, once per end. */
  #turn(t: AgentTurn): void {
    if (t.endedAt === null) return;
    const key = `${t.agentId}#${t.index}#${t.endedAt}`;
    if (this.#written.has(key)) return;
    const paneId = this.#paneOf(t.agentId);
    if (!paneId) return;
    this.#written.add(key);
    const timer = setTimeout(() => void this.#record(t, paneId), this.#settleMs);
    timer.unref?.();
  }

  async #record(t: AgentTurn, paneId: PaneId): Promise<void> {
    const screen = this.#panes.get(paneId) ? await this.#panes.read(paneId, TURN_LINES).catch(() => "") : "";
    const text = turnScreen(screen, t.prompt);
    if (!text || this.#disposed) return;
    const pane = this.#panes.get(paneId);
    this.#data.record({ id: `output:${t.agentId}:${t.index}`, at: t.startedAt, until: t.endedAt, type: "agent.output", source: "pty", paneId, agentId: t.agentId, spaceId: pane?.spaceId ?? null, sessionId: t.sessionId ? `${t.agentKind}:${t.sessionId}` : null, text: `turn ${t.index}: ${text.length} characters`, data: { turn: t.index, chars: text.length, cut: text.length > 256_000 }, content: text });
  }
}

/**
 * A turn's part of a rendered screen: from the last line echoing its prompt
 * (else the last lines), without the input box an agent draws at the bottom
 * (a rule, the prompt line, a rule, status lines), blank runs collapsed.
 */
export function turnScreen(screen: string, prompt: string | null): string {
  const lines = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  const squash = (x: string) => x.replace(/\s+/g, " ").trim();
  const head = squash(prompt?.split("\n").find((l) => l.trim()) ?? "").slice(0, 30);
  let from = -1;
  if (head.length >= 4) for (let i = lines.length - 1; i >= 0 && from < 0; i--) if (squash(lines[i]!).includes(head)) from = i;
  let out = lines.slice(from >= 0 ? from : Math.max(0, lines.length - FALLBACK_LINES));
  const rule = (l: string) => /^\s*[─━═-]{20,}\s*$/.test(l);
  const tail = Math.max(1, out.length - 8);
  const box = out.findIndex((l, i) => i >= tail && rule(l));
  if (box > 0) out = out.slice(0, box);
  const kept: string[] = [];
  for (const l of out) if (l || kept.at(-1)) kept.push(l);
  while (kept.length && !kept.at(-1)) kept.pop();
  return kept.join("\n");
}

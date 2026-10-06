// What agents' panes print (docs/28 §2, requirement A7), recorded two ways:
// - `pane.activity`: stretches of output (at → until). The reducer's timing rules
//   read terminal activity (quiet for 30 s ends a turn, output after a question
//   means it was answered), so a rebuild needs it to give the turns the live
//   core gave (ActivityView.rebuild). A new stretch starts after a second of
//   quiet; the open one is saved every couple of seconds, not on every chunk.
// - `agent.output`: what a turn printed, escape codes stripped, once it ends.
// Only panes running an agent: plain terminals' output is their commands'.

import type { AgentTurn, PaneId } from "@cmd/protocol";
import { stripAnsi } from "../../commands.ts";
import type { PaneManager } from "../../panes.ts";
import type { DataService } from "../service.ts";
import type { ActivityView } from "../views/activity.ts";

/** Quiet longer than this starts a new stretch. */
export const STRETCH_GAP_MS = 1000;
/** The open stretch is saved this often. */
const SAVE_EVERY_MS = 2000;
/** Output kept per pane for its turn (the class cap cuts what's recorded further). */
const KEEP_CHARS = 600_000;

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
  #chunks = new Map<PaneId, { t: number; text: string }[]>();
  #sizes = new Map<PaneId, number>();
  #written = new Set<string>();
  #timer: ReturnType<typeof setInterval>;
  #paneOf: (agentId: string) => PaneId | null;

  constructor(o: { data: DataService; panes: PaneManager; activity: ActivityView; paneOf: (agentId: string) => PaneId | null }) {
    this.#data = o.data;
    this.#panes = o.panes;
    this.#paneOf = o.paneOf;
    o.panes.on("output", (id, text) => this.#output(id, text));
    o.panes.on("removed", (id) => (this.#close(id), this.#chunks.delete(id), this.#sizes.delete(id)));
    o.activity.onTurn((t) => this.#turn(t));
    this.#timer = setInterval(() => this.#saveOpen(), SAVE_EVERY_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.#timer);
    for (const id of [...this.#stretch.keys()]) this.#close(id);
  }

  #output(id: PaneId, text: string, now = Date.now()): void {
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
    const chunks = this.#chunks.get(id) ?? [];
    chunks.push({ t: now, text });
    let size = (this.#sizes.get(id) ?? 0) + text.length;
    while (size > KEEP_CHARS && chunks.length > 1) size -= chunks.shift()!.text.length;
    this.#chunks.set(id, chunks);
    this.#sizes.set(id, size);
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

  /** A turn that ended: what its pane printed meanwhile, once per end. */
  #turn(t: AgentTurn): void {
    if (t.endedAt === null) return;
    const key = `${t.agentId}#${t.index}#${t.endedAt}`;
    if (this.#written.has(key)) return;
    const paneId = this.#paneOf(t.agentId);
    if (!paneId) return;
    this.#written.add(key);
    const text = cleanOutput((this.#chunks.get(paneId) ?? []).filter((c) => c.t >= t.startedAt && c.t <= t.endedAt! + 1500).map((c) => c.text).join(""));
    if (!text) return;
    const pane = this.#panes.get(paneId);
    this.#data.record({ id: `output:${t.agentId}:${t.index}`, at: t.startedAt, until: t.endedAt, type: "agent.output", source: "pty", paneId, agentId: t.agentId, spaceId: pane?.spaceId ?? null, sessionId: t.sessionId ? `${t.agentKind}:${t.sessionId}` : null, text: `turn ${t.index}: ${text.length} characters`, data: { turn: t.index, chars: text.length, cut: text.length > 256_000 }, content: text });
  }
}

/** A TUI's output as text: escape codes out, the spinner's repeated redraws collapsed. */
export function cleanOutput(raw: string): string {
  const lines = stripAnsi(raw).split("\n").map((l) => l.replace(/\s+$/, ""));
  const out: string[] = [];
  for (const l of lines) if (l && l !== out.at(-1)) out.push(l);
  return out.join("\n");
}

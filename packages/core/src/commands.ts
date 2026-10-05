// The command log: what terminals' shells ran, from the shell integration's
// OSC 133 marks (C: a command starts, D: it ended, with its exit status) and its
// exec request (the command line, which zsh and bash send just after C). Kept in
// memory, the newest MAX_RUNS; the Commands widget lists them. Terminals cmd
// started an agent in are left out: the agent's own state says what it does.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { CommandRun, PaneId, SpaceId } from "@cmd/protocol";
import type { PaneManager } from "./panes.ts";

export const MAX_RUNS = 300;

export class CommandLog extends EventEmitter<{ updated: [CommandRun] }> {
  #panes: PaneManager;
  /** Oldest first. */
  #runs: CommandRun[] = [];
  #running = new Map<PaneId, CommandRun>();

  constructor(panes: PaneManager) {
    super();
    this.#panes = panes;
    panes.on("osc", (id, ev) => {
      if (ev.type !== "prompt") return;
      if (ev.mark === "C") this.#start(id);
      else if (ev.mark === "D") this.#end(id, ev.exitCode ?? null);
      // A prompt without D (the shell was killed mid-command, or no D support): the run is over.
      else if (ev.mark === "A") this.#end(id, null);
    });
    panes.on("exec", (id, command) => {
      const run = this.#running.get(id);
      if (run && run.command === null) {
        run.command = command;
        this.emit("updated", { ...run });
      }
    });
    panes.on("removed", (id) => this.#end(id, null));
  }

  /** Newest first, of one Space or all. */
  list(spaceId?: SpaceId): CommandRun[] {
    const out: CommandRun[] = [];
    for (let i = this.#runs.length - 1; i >= 0; i--) {
      const r = this.#runs[i]!;
      if (!spaceId || r.spaceId === spaceId) out.push({ ...r });
    }
    return out;
  }

  #start(id: PaneId): void {
    const pane = this.#panes.get(id);
    if (!pane || pane.agentId) return;
    this.#end(id, null);
    const run: CommandRun = { id: randomUUID(), paneId: id, spaceId: pane.spaceId, command: null, cwd: pane.cwd, startedAt: Date.now(), endedAt: null, exitCode: null };
    this.#running.set(id, run);
    this.#runs.push(run);
    if (this.#runs.length > MAX_RUNS) this.#runs.splice(0, this.#runs.length - MAX_RUNS);
    this.emit("updated", { ...run });
  }

  #end(id: PaneId, exitCode: number | null): void {
    const run = this.#running.get(id);
    if (!run) return;
    this.#running.delete(id);
    run.endedAt = Date.now();
    run.exitCode = exitCode;
    this.emit("updated", { ...run });
  }
}

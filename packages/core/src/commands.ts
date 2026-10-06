// Commands terminals' shells ran, from the shell integration's OSC 133 marks
// (C: a command starts, D: it ended, with its exit status) and its exec request
// (the command line, which zsh and bash send just after C). A run in flight is
// in memory; a finished one is a `command` event in the log, with what it
// printed as the event's content (bounded; the data layer's class cap and
// retention apply). The Commands widget lists both. Terminals cmd started an
// agent in are left out: the agent's own state says what it does.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { CommandRun, DataEvent, EventPayloads, PaneId, SpaceId } from "@cmd/protocol";
import type { DataService } from "./data/service.ts";
import type { PaneManager } from "./panes.ts";

/** Finished runs the widget lists. */
export const MAX_RUNS = 300;

/** Escape sequences out of captured output: colours, cursor moves, OSC titles, carriage returns. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g, "");

export class CommandLog extends EventEmitter<{ updated: [CommandRun] }> {
  #panes: PaneManager;
  #data: DataService | null;
  #running = new Map<PaneId, CommandRun>();
  /** What a pane printed during its current command (panes.ts captures between C and D). */
  #output = new Map<PaneId, string>();

  constructor(panes: PaneManager, data: DataService | null = null) {
    super();
    this.#panes = panes;
    this.#data = data;
    panes.on("osc", (id, ev) => {
      if (ev.type !== "prompt") return;
      if (ev.mark === "C") this.#start(id);
      else if (ev.mark === "D") this.#end(id, ev.exitCode ?? null);
      // A prompt without D (the shell was killed mid-command, or no D support): the run is over.
      else if (ev.mark === "A") this.#end(id, null);
    });
    panes.on("captured", (id, output) => this.#output.set(id, output));
    panes.on("exec", (id, command) => {
      const run = this.#running.get(id);
      if (run && run.command === null) {
        run.command = command;
        this.emit("updated", { ...run });
      }
    });
    panes.on("removed", (id) => this.#end(id, null));
  }

  /** Newest first, of one Space or all: the runs in flight, then the finished ones from the log. */
  list(spaceId?: SpaceId): CommandRun[] {
    const out: CommandRun[] = [];
    for (const r of [...this.#running.values()].sort((a, b) => b.startedAt - a.startedAt)) if (!spaceId || r.spaceId === spaceId) out.push({ ...r });
    if (this.#data) for (const e of this.#data.query({ types: ["command"], spaceId, order: "desc", limit: MAX_RUNS })) out.push(toRun(e));
    return out;
  }

  #start(id: PaneId): void {
    const pane = this.#panes.get(id);
    if (!pane || pane.agentId) return;
    this.#end(id, null);
    const run: CommandRun = { id: randomUUID(), paneId: id, spaceId: pane.spaceId, command: null, cwd: pane.cwd, startedAt: Date.now(), endedAt: null, exitCode: null };
    this.#running.set(id, run);
    this.emit("updated", { ...run });
  }

  #end(id: PaneId, exitCode: number | null): void {
    const run = this.#running.get(id);
    const output = this.#output.get(id);
    this.#output.delete(id);
    if (!run) return;
    this.#running.delete(id);
    run.endedAt = Date.now();
    run.exitCode = exitCode;
    // A run without a command line (bash without a preexec hook) is still a run.
    if (this.#data) {
      const text = output ? stripAnsi(output) : "";
      this.#data.record({
        id: `command:${run.id}`,
        at: run.startedAt,
        until: run.endedAt,
        type: "command",
        source: "osc",
        paneId: run.paneId,
        spaceId: run.spaceId,
        projectId: `dir:${run.cwd}`,
        text: run.command?.split("\n")[0]?.slice(0, 300) ?? null,
        body: run.command,
        data: { command: run.command?.slice(0, 4096) ?? null, exitCode, cwd: run.cwd, output: text ? { chars: text.length, cut: false } : null },
        content: text || null,
      });
    }
    this.emit("updated", { ...run });
  }
}

function toRun(e: DataEvent): CommandRun {
  const d = e.data as EventPayloads["command"];
  return { id: e.id.replace(/^command:/, ""), paneId: e.paneId ?? "", spaceId: e.spaceId ?? "", command: d.command, cwd: d.cwd, startedAt: e.at, endedAt: e.until, exitCode: d.exitCode };
}

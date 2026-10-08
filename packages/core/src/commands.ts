// Commands terminals' shells ran, from the shell integration's OSC 133 marks
// (C: a command starts, D: it ended, with its exit status) and its exec request
// (the command line, which zsh and bash send just after C). Every run is a
// `command` event in the log from the moment it starts (no end yet), updated
// when its line arrives and when it ends, then with what it printed as the
// event's content (bounded; the data layer's class cap and retention apply).
// The Commands widget subscribes to those events. Terminals cmd started an
// agent in are left out: the agent's own state says what it does.

import { randomUUID } from "node:crypto";
import type { CommandRun, PaneId } from "@cmd/protocol";
import type { DataService } from "./data/service.ts";
import type { PaneManager } from "./panes.ts";
import { projectIdOf } from "./data/project.ts";

/** Escape sequences out of captured output: colours, cursor moves, OSC titles, carriage returns. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g, "");

/**
 * A command's output as recorded: escape codes out, without the partial-line
 * marker zsh and fish print after it (`%` or `⏎` and a screen's width of
 * spaces, drawn over by the next prompt), trailing blank space trimmed.
 */
export const commandOutput = (raw: string) => stripAnsi(raw).replace(/[%#⏎] {8,}[ \t]*$/, "").trimEnd();

/** How much of what a command printed is searchable: its end, where the result and the errors are. */
const OUTPUT_INDEXED = 16_000;

/** What a command is found by: its line, then the end of its output. */
export function commandBody(command: string | null, output: string | null): string | null {
  const tail = output ? output.slice(-OUTPUT_INDEXED) : "";
  return [command, tail].filter(Boolean).join("\n") || null;
}

/**
 * Once per log: commands recorded before their output was searchable get it in
 * the full-text index (from their content blobs), a page at a time between yields.
 */
export async function indexCommandOutput(data: DataService, pace: { yield(): Promise<void> }): Promise<number> {
  const store = data.store;
  if (store.meta("fts.commandOutput")) return 0;
  let after = 0;
  let n = 0;
  for (;;) {
    const page = store.query({ types: ["command"], after, limit: 500 });
    if (!page.length) break;
    store.transaction(() => {
      for (const e of page) {
        if (!e.blob) continue;
        const output = store.blob(e.blob)?.toString("utf8") ?? null;
        const command = typeof (e.data as { command?: unknown }).command === "string" ? ((e.data as { command: string }).command) : e.text;
        store.reindex(e.seq, e.text, commandBody(command, output));
        n++;
      }
    });
    after = page[page.length - 1]!.seq;
    await pace.yield();
  }
  store.setMeta("fts.commandOutput", "1");
  return n;
}

export class CommandLog {
  #panes: PaneManager;
  #data: DataService | null;
  #running = new Map<PaneId, CommandRun>();
  /** What a pane printed during its current command (panes.ts captures between C and D). */
  #output = new Map<PaneId, string>();

  constructor(panes: PaneManager, data: DataService | null = null) {
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
        this.#record(run, null);
      }
    });
    panes.on("removed", (id) => this.#end(id, null));
  }

  #start(id: PaneId): void {
    const pane = this.#panes.get(id);
    if (!pane || pane.agentId) return;
    this.#end(id, null);
    const run: CommandRun = { id: randomUUID(), paneId: id, spaceId: pane.spaceId, command: null, cwd: pane.cwd, git: pane.git ?? null, startedAt: Date.now(), endedAt: null, exitCode: null };
    this.#running.set(id, run);
    this.#record(run, null);
  }

  #end(id: PaneId, exitCode: number | null): void {
    const run = this.#running.get(id);
    const output = this.#output.get(id);
    this.#output.delete(id);
    if (!run) return;
    this.#running.delete(id);
    run.endedAt = Date.now();
    run.exitCode = exitCode;
    this.#record(run, output ? commandOutput(output) || null : null);
  }

  /** The run as it is now, into the log (the same id: an update). A run without a command line (bash without a preexec hook) is still a run. */
  #record(run: CommandRun, output: string | null): void {
    this.#data?.record({
      id: `command:${run.id}`,
      at: run.startedAt,
      until: run.endedAt,
      type: "command",
      source: "osc",
      paneId: run.paneId,
      spaceId: run.spaceId,
      projectId: projectIdOf(run.cwd),
      text: run.command?.split("\n")[0]?.slice(0, 300) ?? null,
      body: commandBody(run.command, output),
      data: { command: run.command?.slice(0, 4096) ?? null, exitCode: run.exitCode, cwd: run.cwd, git: run.git ?? null, output: output ? { chars: output.length, cut: false } : null },
      content: output || null,
    });
  }
}


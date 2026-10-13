// pane.waitFor: until a terminal shows something (on its screen now, or printed next), or is back at its prompt. For whoever
// types into a terminal and needs to know when the command is done (a tool, docs/54;
// agents in panes through the CLI): the output and the shell integration's OSC 133 marks,
// never a fixed wait.

import type { PaneId } from "@cmd/protocol";
import type { PaneManager } from "./panes.ts";
import { stripAnsi } from "./commands.ts";

const DEFAULT_MS = 60_000;
const MAX_MS = 10 * 60_000;
/** With `prompt`: a command that hasn't started by now (no C mark) means it was already back at its prompt. */
const START_GRACE_MS = 1500;
/** How much of the screen counts as already printed. */
const SCREEN_LINES = 200;

export interface WaitFor {
  text?: string;
  prompt?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WaitResult {
  matched: boolean;
  timedOut: boolean;
  /** The ended command's exit status (D mark), when it reported one. */
  exitCode: number | null;
  tail: string;
}

export function waitForPane(panes: PaneManager, paneId: PaneId, o: WaitFor): Promise<WaitResult> {
  if (!panes.get(paneId)) return Promise.reject(new Error(`no terminal ${paneId}`));
  if (!o.text && !o.prompt) return Promise.reject(new Error("wait for text or the prompt"));
  const ms = Math.min(Math.max(o.timeoutMs ?? DEFAULT_MS, 0), MAX_MS);
  return new Promise((resolve) => {
    let seen = "";
    let started = false;
    let exitCode: number | null = null;
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const finish = (matched: boolean, timedOut: boolean) => {
      if (done) return;
      done = true;
      panes.off("output", onOutput);
      panes.off("osc", onOsc);
      panes.off("removed", onRemoved);
      o.signal?.removeEventListener("abort", onAbort);
      for (const t of timers) clearTimeout(t);
      void Promise.resolve().then(() => panes.read(paneId, 30)).then(
        (tail) => resolve({ matched, timedOut, exitCode, tail }),
        () => resolve({ matched, timedOut, exitCode, tail: "" }),
      );
    };
    const onOutput = (id: PaneId, data: string) => {
      if (id !== paneId || !o.text) return;
      // Kept short: only a match across chunks needs what came before.
      seen = (seen + stripAnsi(data)).slice(-(o.text.length + 8192));
      if (seen.includes(o.text)) finish(true, false);
    };
    const onOsc = (id: PaneId, ev: { type: string; mark?: string; exitCode?: number | null }) => {
      if (id !== paneId || !o.prompt || ev.type !== "prompt") return;
      if (ev.mark === "C") started = true;
      else if (ev.mark === "D" || (ev.mark === "A" && started)) {
        if (ev.mark === "D") exitCode = ev.exitCode ?? null;
        finish(true, false);
      }
    };
    const onRemoved = (id: PaneId) => id === paneId && finish(false, false);
    const onAbort = () => finish(false, false);
    panes.on("output", onOutput);
    panes.on("osc", onOsc as never);
    panes.on("removed", onRemoved);
    o.signal?.addEventListener("abort", onAbort);
    timers.push(setTimeout(() => finish(false, true), ms));
    if (o.prompt) timers.push(setTimeout(() => !started && finish(true, false), Math.min(START_GRACE_MS, ms)));
    // Text already on the screen counts: it was printed before the wait began (a server's address).
    if (o.text) {
      const text = o.text;
      void Promise.resolve()
        .then(() => panes.read(paneId, SCREEN_LINES))
        .then((screen) => !done && screen.includes(text) && finish(true, false), () => {});
    }
  });
}

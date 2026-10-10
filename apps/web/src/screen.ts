// The phone's terminal without the DOM (Terminal.tsx draws it): the core's snapshot
// replayed at the size it was made at, the output it doesn't show after it (each byte
// once), and sizing held while the snapshot is parsed (@cmd/protocol/replay says why).

import { OutputGate, Replayer, type ReplayTerm } from "@cmd/protocol/replay";

/** What the screen needs of a terminal (xterm.js; @xterm/headless in tests). */
export interface ScreenTerm extends ReplayTerm {
  reset(): void;
}

export interface Size {
  cols: number;
  rows: number;
}

export class Screen {
  #term: ScreenTerm;
  #replays: Replayer;
  /** Output arriving before the snapshot waits for it; an older Mac's is all written after it. */
  #gate = new OutputGate("keep");
  /** Runs once a snapshot is parsed: the size held meanwhile applies now. */
  onParsed: () => void = () => {};

  constructor(term: ScreenTerm) {
    this.#term = term;
    this.#replays = new Replayer(term);
  }

  /** A snapshot is written and not parsed yet: sizes wait. */
  get busy(): boolean {
    return this.#replays.busy;
  }

  /** A new snapshot was asked for (a resync): output waits for it. */
  awaitSnapshot(): void {
    this.#gate.wait();
  }

  snapshot(snap: Size & { data: string; seq?: number }): void {
    this.#term.reset();
    this.#replays.replay(snap.data, snap, () => this.onParsed());
    const rest = this.#gate.snapshot(snap.seq);
    if (rest) this.#term.write(rest);
  }

  /** A pane.output event (its `seq`, from a Mac that sends one). */
  output(data: string, seq?: number): void {
    const d = this.#gate.output(data, seq);
    if (d) this.#term.write(d);
  }

  /**
   * Take `size`, then `tell` the Mac (pane.fitOverride resizes its PTY, and the shell
   * redraws for it). Not while a snapshot is parsed: the rest would replay at another
   * width and the redraw would wipe lines; onParsed asks again. False when held.
   */
  resize(size: Size, tell?: () => void): boolean {
    if (this.busy) return false;
    const t = this.#term;
    if (t.cols !== size.cols || t.rows !== size.rows) t.resize(size.cols, size.rows);
    tell?.();
    return true;
  }
}

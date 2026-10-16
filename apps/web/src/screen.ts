// The phone's terminal without the DOM (Terminal.tsx draws it): the core's snapshot
// replayed at the size it was made at, the output it doesn't show after it (each byte
// once), and sizing held while the snapshot is parsed (@cmd/protocol/replay says why).
// After a reconnect the same terminal carries on: a snapshot with nothing new in it
// (its seq is the last one written) is skipped instead of replayed, so the screen
// neither blinks nor loses its place.

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
  /** How much of the pane's output this terminal shows (pane.output's seq), when the Mac counts. */
  #seq: number | undefined;
  /** A snapshot has been written: a later one is a resync. */
  #shown = false;
  /** The last seq that waited for the snapshot: the gate writes what the snapshot doesn't show. */
  #waited: number | undefined;

  constructor(term: ScreenTerm) {
    this.#term = term;
    this.#replays = new Replayer(term);
  }

  /** A snapshot is written and not parsed yet: sizes wait. */
  get busy(): boolean {
    return this.#replays.busy;
  }

  /** A snapshot was written before: the terminal shows something. */
  get shown(): boolean {
    return this.#shown;
  }

  /** A new snapshot was asked for (a resync): output waits for it. */
  awaitSnapshot(): void {
    this.#waited = undefined;
    this.#gate.wait();
  }

  /**
   * The core's snapshot. True when it was replayed; false when this terminal already
   * shows all of it at its size (a reconnect that missed nothing), and only the output
   * after it is written.
   */
  snapshot(snap: Size & { data: string; seq?: number }): boolean {
    const t = this.#term;
    const same = this.#shown && snap.seq !== undefined && snap.seq === this.#seq && snap.cols === t.cols && snap.rows === t.rows;
    this.#shown = true;
    if (!same) {
      t.reset();
      this.#replays.replay(snap.data, snap, () => this.onParsed());
    }
    if (snap.seq !== undefined) this.#seq = Math.max(snap.seq, this.#waited ?? 0);
    const rest = this.#gate.snapshot(snap.seq);
    if (rest) this.#term.write(rest);
    if (same) this.onParsed();
    return !same;
  }

  /** A pane.output event (its `seq`, from a Mac that sends one). */
  output(data: string, seq?: number): void {
    if (seq !== undefined && this.#gate.waiting) this.#waited = seq;
    const d = this.#gate.output(data, seq);
    if (d) this.#term.write(d);
    if (seq !== undefined && !this.#gate.waiting) this.#seq = Math.max(this.#seq ?? 0, seq);
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

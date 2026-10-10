// Replaying a pane's snapshot (the core's serialized screen) into a terminal at the size
// it was made at, and knowing when it is parsed, so nothing resizes the terminal meanwhile.
// Both clients replay this way: the app (renderer terminals.ts) and the web client
// (apps/web screen.ts).

/** What a replay needs of a terminal (xterm.js; @xterm/headless in tests). */
export interface ReplayTerm {
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): void;
  write(data: string, parsed?: () => void): void;
}

/**
 * A snapshot's wrapping and cursor moves only replay right at its own size. xterm parses
 * writes later, in slices (on a slow machine, over several tasks), so a resize before the
 * snapshot is parsed (the view attaching and fitting, its tile resizing) replays the rest
 * at another width: wrapped lines join differently and the cursor lands elsewhere. The
 * PTY hears the new size too, and the shell redraws its prompt for it from where it left
 * the cursor (zsh: up over a wrapped prompt, clear below), wiping lines of output the
 * core still has. So: while `busy`, don't resize; `then` runs once the snapshot is parsed.
 */
export class Replayer {
  #term: ReplayTerm;
  #pending = 0;

  constructor(term: ReplayTerm) {
    this.#term = term;
  }

  /** A snapshot is written and not parsed yet: leave the size alone. */
  get busy(): boolean {
    return this.#pending > 0;
  }

  replay(data: string, size: { cols: number; rows: number }, then?: () => void): void {
    const t = this.#term;
    if (size.cols !== t.cols || size.rows !== t.rows) t.resize(size.cols, size.rows);
    this.#pending++;
    t.write(data, () => {
      this.#pending--;
      if (!this.#pending) then?.();
    });
  }
}

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

/**
 * Of a pane.output event (`data`, ending at `seq`), what a snapshot showing output up to
 * `shown` doesn't: all of it, its tail, or "". Null when either has no seq (an older core).
 */
export function unseen(data: string, seq: number | undefined, shown: number | undefined): string | null {
  if (seq === undefined || shown === undefined) return null;
  if (seq <= shown) return "";
  const start = seq - data.length;
  return start >= shown ? data : data.slice(shown - start);
}

/**
 * A terminal's output around a snapshot, each byte once. Output arriving while the
 * snapshot is asked for waits; the snapshot's reply lets through what it doesn't show
 * already. The core sends output in order, but around the reply both ways happen:
 * output the snapshot shows can arrive before the reply (a terminal printing meanwhile)
 * or after it (a remote session holds output COALESCE_MS), and output it doesn't show
 * before it (the PTY host's next lines). So the counts decide (pane.output's and the
 * snapshot's `seq`), until output passes the snapshot. Without them (an older core),
 * output that waited is written (`keep`) or dropped (`drop`), as each client did.
 */
export class OutputGate {
  #legacy: "keep" | "drop";
  /** A new gate waits for a snapshot. */
  #waiting = true;
  #early: { data: string; seq?: number }[] = [];
  /** What the snapshot shows, while output may still overlap it. */
  #shown: number | null = null;

  constructor(legacy: "keep" | "drop") {
    this.#legacy = legacy;
  }

  /** Nothing left to filter: the snapshot is applied and output has passed it. */
  get done(): boolean {
    return !this.#waiting && this.#shown === null;
  }

  /** Output waits for a snapshot. */
  get waiting(): boolean {
    return this.#waiting;
  }

  /** A (new) snapshot was asked for: output waits for it. */
  wait(): void {
    this.#waiting = true;
    this.#early = [];
    this.#shown = null;
  }

  /** A pane.output event: what to write now. */
  output(data: string, seq?: number): string {
    if (this.#waiting) {
      this.#early.push({ data, seq });
      return "";
    }
    if (this.#shown === null) return data;
    const rest = unseen(data, seq, this.#shown);
    if (rest === null || seq! > this.#shown) this.#shown = null;
    return rest ?? data;
  }

  /** The snapshot (its `seq`) is written: what of the output that waited to write after it. */
  snapshot(seq?: number): string {
    const early = this.#early;
    this.#early = [];
    this.#waiting = false;
    if (seq === undefined) return this.#legacy === "keep" ? early.map((e) => e.data).join("") : "";
    this.#shown = seq;
    return early.map((e) => this.output(e.data, e.seq)).join("");
  }
}

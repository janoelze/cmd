// What the pane manager needs from a terminal: a PTY whose output is mirrored
// into a headless xterm, the terminal's real screen state. Two backends:
// in-process (local.ts, tests and fallback) and the PTY host process (remote.ts),
// which keeps terminals running while the core restarts.

import type { SpawnOptions } from "./pty.ts";

export interface TermSpawn extends SpawnOptions {
  /** The pane id; kept across core restarts. */
  id: string;
  scrollback: number;
  /** Written to the screen before any output: a restored pane's old contents. */
  replay?: string;
}

export interface Snapshot {
  data: string;
  cols: number;
  rows: number;
}

export interface Term {
  readonly id: string;
  /** Shell pid; 0 until a remote spawn has been confirmed (see ready). */
  readonly pid: number;
  /** Settles once the terminal runs (pid known), or rejects if it couldn't start. */
  readonly ready: Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Foreground process name, for when procinfo is missing. */
  process(): Promise<string>;
  /**
   * The screen serialized. `restore`: the normal buffer only, without modes,
   * ending below the last line: what a new pane shows of an old one.
   */
  snapshot(o: { scrollback: number; restore?: boolean }): Promise<Snapshot>;
  /** The last `lines` lines of text (screen + scrollback, as displayed). */
  read(lines: number): Promise<string>;
  /** Clear stuck terminal state (modes a crashed program left on). */
  reset(): Promise<void>;
  onData(fn: (data: string) => void): void;
  onExit(fn: (exitCode: number | null) => void): void;
}

export interface TermBackend {
  /**
   * Who keeps the terminals. A pane recorded under another instance lost its
   * process (the host or core it ran in is gone) and is resurrected; one under
   * this instance that isn't attached() has exited.
   */
  readonly instance: string;
  spawn(o: TermSpawn): Term;
  /** Terminals still running from before this core started. */
  attached(): Term[];
  /** The PTY host process, for diagnostics; absent: terminals run in the core. */
  info?(): { pid: number; startedAt: number; root: string };
  /** Called if the terminals die with the backend (the PTY host crashed); not after dispose(). */
  onLost?(fn: () => void): void;
  /** Stop using the backend: a local one kills its terminals, the PTY host keeps them. */
  dispose(): void;
}

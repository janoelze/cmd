// Types of the `cmd` object inside a widget's frame (prompt/host.js), for
// type-checking view.ts. A view imports its data type from data.ts:
//   import type { Data } from "./data.ts";
//   cmd.onData<Data>((d) => { … });

interface CmdChartSeries {
  name?: string;
  values: number[];
  color?: string;
}

interface CmdChartOptions {
  type: "line" | "bar";
  labels?: (string | number)[];
  series: CmdChartSeries[];
  area?: boolean;
  min?: number;
  max?: number;
  format?: (n: number) => string;
}

interface CmdFrame {
  /** Called with the data now (if any) and after every refresh; validated against data.ts's schema. */
  onData<T>(fn: (data: T) => void): void;
  /** The latest data, or undefined before the first refresh. */
  readonly data: unknown;
  /** fn("dark" | "light") now and whenever the theme changes; redraw canvas colours here. */
  onTheme(fn: (appearance: "dark" | "light") => void): void;
  fmt: {
    num(n: number | null | undefined, digits?: number): string;
    bytes(n: number | null | undefined): string;
    /** n is 0–100. */
    pct(n: number | null | undefined, digits?: number): string;
    /** Seconds → "3h 12m". */
    dur(seconds: number | null | undefined): string;
    ago(t: Date | string | number): string;
    time(t: Date | string | number): string;
    date(t: Date | string | number): string;
  };
  spark(el: Element, values: number[], o?: { min?: number; max?: number; color?: string }): void;
  chart(el: Element, o: CmdChartOptions): void;
  /** Small values kept for this window across reloads and restarts (a chosen tab, a timer's start). */
  state: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };
  /** The last `max` values of a live number across refreshes and restarts (for sparklines). */
  history(key: string, value: number | null | undefined, max?: number): number[];
  /** Open a link in a browser window (the widget itself never navigates). */
  openUrl(url: string): void;
  /**
   * Open a new terminal in the window's folder with `command` typed in (not
   * run: the person presses Return). Only in response to a click or key press.
   */
  terminal(command: string): void;
  /** Open a file or folder (an absolute or ~/ path) in a cmd window. Only in response to a click or key press. */
  open(path: string): void;
  /** Copy text to the clipboard. Only in response to a click or key press. */
  copy(text: string): void;
  /** Play a macOS system sound; silent while the widget is muted. */
  sound(name?: "Basso" | "Blow" | "Bottle" | "Frog" | "Funk" | "Glass" | "Hero" | "Morse" | "Ping" | "Pop" | "Purr" | "Sosumi" | "Submarine" | "Tink"): void;
}

declare const cmd: CmdFrame;

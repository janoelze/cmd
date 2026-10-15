// The phone driver's command line (`pnpm phone …`): which command, its words and
// its flags, checked here so a typo fails before anything starts. Pure, so the
// tests can hold it.

import { DEVICES, type BrowserName, type DeviceName } from "./harness.ts";

export const COMMANDS = ["start", "stop", "status", "shot", "tap", "type", "key", "goto", "eval", "logs", "ls", "help"] as const;
export type Command = (typeof COMMANDS)[number];

/** Flags that take no value. */
const SWITCHES = new Set(["keyboard", "json", "help"]);
/** Flags that take one, and the commands they belong to. */
const VALUES: Record<string, Command[]> = {
  core: ["start"],
  browser: ["start"],
  device: ["start", "shot"],
  theme: ["shot"],
  out: ["shot"],
  lines: ["logs"],
};

export type CoreChoice = { kind: "scenario"; name: string } | { kind: "dev" };

export interface Parsed {
  command: Command;
  args: string[];
  flags: Record<string, string | true>;
}

/** `pnpm phone <command> [words…] [--flag value | --switch]`; throws a message that says what to type instead. */
export function parseArgs(argv: string[]): Parsed {
  const [first, ...rest] = argv;
  const command = (first ?? "help") as Command;
  if (!COMMANDS.includes(command)) throw new Error(`There's no “${first}” command. Try: ${COMMANDS.join(", ")}.`);
  const args: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--") || a === "--") {
      args.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s) as [string, string | undefined];
    if (SWITCHES.has(name)) {
      flags[name] = true;
      continue;
    }
    if (!VALUES[name]?.includes(command)) throw new Error(`${command} doesn't take --${name}.`);
    const value = inline ?? rest[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
    flags[name] = value;
  }
  if (typeof flags.device === "string") deviceName(flags.device);
  if (typeof flags.browser === "string" && !["webkit", "chromium"].includes(flags.browser)) throw new Error(`--browser is webkit or chromium, not “${flags.browser}”.`);
  if (typeof flags.theme === "string" && !["light", "dark", "all"].includes(flags.theme)) throw new Error(`--theme is light, dark or all, not “${flags.theme}”.`);
  if (typeof flags.core === "string") parseCore(flags.core);
  if (typeof flags.lines === "string" && !(Number(flags.lines) > 0)) throw new Error("--lines needs a number above 0.");
  const need: Partial<Record<Command, string>> = { tap: "what to tap (a selector or its text)", type: "the text to type", key: "a key (enter, esc, tab, up, ctrl-c…)", goto: "a terminal (its id or title), or now", eval: "the JavaScript to run" };
  if (need[command] && !args.length) throw new Error(`${command} needs ${need[command]}.`);
  return { command, args, flags };
}

export function deviceName(s: string): DeviceName {
  if (s in DEVICES) return s as DeviceName;
  throw new Error(`--device is se, 15 or promax, not “${s}”.`);
}

export const browserName = (s: string | true | undefined): BrowserName | null => (s === "chromium" || s === "webkit" ? s : null);

/** --core: scenario (the default one), scenario:<name>, or dev (this checkout's own core). */
export function parseCore(s: string | true | undefined): CoreChoice {
  if (s === undefined || s === true || s === "scenario") return { kind: "scenario", name: "default" };
  if (s === "dev") return { kind: "dev" };
  const m = /^scenario:([a-z0-9][a-z0-9-]*)$/.exec(s);
  if (m) return { kind: "scenario", name: m[1]! };
  throw new Error(`--core is scenario, scenario:<name> or dev, not “${s}”.`);
}

const KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  "shift-tab": "Shift+Tab",
  backspace: "Backspace",
  delete: "Delete",
  space: " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** A key as people write it (enter, esc, ctrl-c, shift-tab, up) → Playwright's name for it. */
export function keyName(s: string): string {
  const k = s.toLowerCase();
  if (KEYS[k]) return KEYS[k];
  const ctrl = /^(?:ctrl|control|\^)-?(.)$/.exec(k);
  if (ctrl) return `Control+${ctrl[1]}`;
  if (/^f([1-9]|1[0-2])$/.test(k)) return k.toUpperCase();
  if ([...s].length === 1) return s;
  throw new Error(`“${s}” isn't a key here. Try enter, esc, tab, shift-tab, up, down, left, right, backspace, space or ctrl-<letter>.`);
}

/** Whether `s` reads as a CSS selector rather than text on screen. */
export const isSelector = (s: string): boolean => /^[.#[]/.test(s) || /^[a-z][a-z0-9-]*([.#[:>]| [.#>[])/.test(s) || /^(button|input|textarea|header|footer|main|nav|form)$/.test(s);

export const HELP = `pnpm phone: the web client in an emulated iPhone, paired with a throwaway core.
  start [--core scenario[:<name>]|dev] [--browser webkit|chromium] [--device se|15|promax]
                       start it in the background (pairs once; the pairing survives restarts)
  stop | status        quit it (and a scenario's core) | what runs where
  shot [--device se|15|promax] [--theme light|dark|all] [--keyboard] [--out dir]
                       screenshots into .cmd-dev/shots/phone-*.png; prints the paths
  tap <selector|text>  tap a button, row or field
  type <text>          type into the focused field, else into the terminal on screen
  key <name>           enter, esc, tab, shift-tab, up, down, left, right, backspace, ctrl-c…
  goto <id|title|now>  open a terminal (as \`ls\` lists it), or go back to Now
  eval '<js>'          run JavaScript in the page and print the result
  ls                   the terminals the phone sees
  logs [--lines n]     the browser's console and errors, then the core's log`;

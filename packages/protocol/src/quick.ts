// Quick Commands (docs/58-quick-commands.md): commands, prompts and links the person saves
// once and runs from the palette, the Session menu, a hotkey or the CLI, kept in
// quick-commands.json. Here: the types, the methods and the {{variable}} language (parse,
// fill in, quote), shared by the core, the app and the CLI.

import type { PaneId, WindowId, WorkspaceId } from "./model.ts";
import type { Placement } from "./rpc.ts";

/** What the menu, the palette and Settings call them; one place to rename. */
export const QUICK_TITLE = "Quick Commands";
export const QUICK_FILE = "quick-commands.json";

/**
 * "terminal": a new terminal in the workspace runs it. "type": typed into the selected terminal
 * (a shell or an agent in it), else run in a new one. "open": a URL or path opened in a cmd window.
 */
export const QUICK_TARGETS = ["type", "terminal", "open"] as const;
export type QuickTarget = (typeof QUICK_TARGETS)[number];

export interface QuickCommand {
  /** Stable across renames: a slug made once from the first name ("push-branch"). */
  id: string;
  name: string;
  description?: string;
  /** The command line, prompt or URL, with {{variables}}. */
  body: string;
  /** Default "type". */
  target?: QuickTarget;
  /** "type": press Return after it (default true). Off: left for you to edit. */
  submit?: boolean;
  /** "terminal" (and "type" without a terminal): the folder it starts in, may use variables (default {{folder}}). */
  cwd?: string;
  /** Shortcuts, Electron accelerator syntax, as in keybindings.json. */
  keys?: string[];
  /** Ask before running, showing the resolved text (a deploy, a force push). */
  confirm?: boolean;
}

/** What the caller is looking at; the core adds the workspace's root, the branch, the clipboard and the time. */
export interface QuickContext {
  workspaceId?: WorkspaceId;
  /** The selected terminal: "type" types into it. */
  paneId?: PaneId;
  folder?: string;
  file?: string;
  selection?: string;
  url?: string;
}

export interface QuickList {
  commands: QuickCommand[];
  /** The file they are kept in; "" when in memory only (tests). */
  path: string;
  /** The file can't be read: the last good commands are kept. */
  error?: string;
  /** Entries left out because they aren't commands ("command 3: needs a name"); they stay in the file. */
  problems?: string[];
}

/** Quick Commands' RPC methods, part of `Methods` (rpc.ts). */
export interface QuickMethods {
  /** Every Quick Command, in the file's order. Changes arrive as quick.changed. */
  "quick.list": { params: {}; result: QuickList };
  /** Add one (no id: made from its name) or replace the one with its id; `before` places it before another. */
  "quick.save": { params: { command: Omit<QuickCommand, "id"> & { id?: string }; before?: string }; result: QuickCommand };
  "quick.remove": { params: { id: string }; result: null };
  /** Move one before another (null: to the end). */
  "quick.move": { params: { id: string; before: string | null }; result: null };
  /**
   * Run one (an id, else a name) with what the caller is looking at and the values asked for. Refused when
   * a variable has no value (the error names it), or when it asks first and isn't `confirmed`.
   */
  "quick.run": { params: Placement & { id: string; context?: QuickContext; values?: Record<string, string>; confirmed?: boolean }; result: QuickRun };
  /** What running it would do, without running it: the text, or what is missing. */
  "quick.resolve": { params: Placement & { id: string; context?: QuickContext; values?: Record<string, string> }; result: QuickResolved };
}

export interface QuickRun {
  /** What was typed, run or opened. */
  text: string;
  paneId?: PaneId;
  windowId?: WindowId;
}

export interface QuickResolved {
  /** The text with every value in, quoted as it will be; null while something is missing. */
  text: string | null;
  /** Variables with no value here ("file": no file is selected). */
  missing: string[];
  /** What it asks for, in order. */
  asks: QuickAsk[];
  /** Where it goes: "shell" (values quoted), "text" (an agent's prompt), "url". */
  mode: QuickMode;
}

/** Quick Commands changed (the file was edited or saved). Part of CoreEvent (rpc.ts). */
export type QuickEvent = { type: "quick.changed" };

// ---- The variable language -------------------------------------------------------------

/** The variables a body can use, and what each is (Settings' Insert Variable menu). */
export const QUICK_VARIABLES = {
  folder: "The selected window's folder, else the workspace's",
  workspace: "The workspace's folder",
  file: "The selected file (a text window's, a file browser's)",
  selection: "The selected text in a terminal or editor",
  clipboard: "The clipboard's text",
  branch: "The folder's git branch",
  repo: "The folder's repository",
  url: "The browser window's page",
  date: "Today, 2026-10-17",
  time: "Now, 15:49",
} as const;
export type QuickVariable = keyof typeof QUICK_VARIABLES;

/** How a value goes in: "raw" as it is, "url" encoded; else as the body needs (quoted for a shell). */
export type QuickModifier = "raw" | "url";
export type QuickMode = "shell" | "text" | "url";

export type QuickAsk = { kind: "ask"; name: string; default: string } | { kind: "pick"; name: string; options: string[] };

export type QuickToken =
  | { kind: "var"; name: QuickVariable; optional: boolean; mod: QuickModifier | null; text: string }
  | (QuickAsk & { mod: QuickModifier | null; text: string });

export interface QuickParsed {
  parts: (string | QuickToken)[];
  /** Context variables used. */
  vars: QuickVariable[];
  /** Asked for when it runs, each name once. */
  asks: QuickAsk[];
  /** "{{fiel}}: no such variable". */
  errors: string[];
}

const TOKEN = /\{\{([^{}]*)\}\}/g;
/** What looks meant as a variable: a lowercase word (`{{.Names}}`, `{{ .Foo }}` and `{{Title}}` are other templates' and stay text). */
const MEANT = /^\s*(ask:|pick:|[a-z][\w-]*\??\s*(\|.*)?$)/;

/** A body's text and variables, and what is wrong with them. */
export function parseQuick(body: string): QuickParsed {
  const parts: QuickParsed["parts"] = [];
  const vars = new Set<QuickVariable>();
  const asks = new Map<string, QuickAsk>();
  const errors: string[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    const inner = m[1]!;
    if (!MEANT.test(inner)) continue;
    const t = token(inner, m[0], errors);
    if (!t) continue;
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(t);
    last = m.index + m[0].length;
    if (t.kind === "var") vars.add(t.name);
    else if (!asks.has(t.name)) asks.set(t.name, t.kind === "ask" ? { kind: "ask", name: t.name, default: t.default } : { kind: "pick", name: t.name, options: t.options });
  }
  if (last < body.length) parts.push(body.slice(last));
  return { parts, vars: [...vars], asks: [...asks.values()], errors };
}

function token(inner: string, text: string, errors: string[]): QuickToken | null {
  const [head = "", ...pipes] = inner.split("|");
  const mods = pipes.map((p) => p.trim());
  const bad = mods.find((x) => x !== "raw" && x !== "url");
  if (bad !== undefined) return (errors.push(`${text}: "${bad}" isn't raw or url`), null);
  const mod = (mods.at(-1) as QuickModifier | undefined) ?? null;
  const h = head.trim();
  const ask = /^(ask|pick):([^=]*)(?:=(.*))?$/s.exec(h);
  if (ask) {
    const name = ask[2]!.trim();
    if (!name) return (errors.push(`${text}: name what it asks for, {{${ask[1]}:name}}`), null);
    if (ask[1] === "ask") return { kind: "ask", name, default: ask[3]?.trim() ?? "", mod, text };
    const options = (ask[3] ?? "").split(",").map((o) => o.trim()).filter(Boolean);
    if (!options.length) return (errors.push(`${text}: list the choices, {{pick:${name}=a,b}}`), null);
    return { kind: "pick", name, options, mod, text };
  }
  const optional = h.endsWith("?");
  const name = optional ? h.slice(0, -1) : h;
  if (!(name in QUICK_VARIABLES)) return (errors.push(`${text}: no such variable`), null);
  return { kind: "var", name: name as QuickVariable, optional, mod, text };
}

/** A value as one shell word: 'it'\''s'. */
export const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Fill a parsed body in: each value quoted for `mode` unless its modifier says otherwise. A
 * variable without a value (and not optional) is missing; an ask without a value takes its default.
 */
export function fillQuick(p: QuickParsed, mode: QuickMode, vars: Partial<Record<QuickVariable, string>>, values: Record<string, string> = {}): { text: string | null; missing: string[] } {
  const missing: string[] = [];
  let out = "";
  for (const part of p.parts) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    let v: string | undefined;
    if (part.kind === "var") {
      v = vars[part.name] || undefined;
      if (v === undefined) {
        if (!part.optional && !missing.includes(part.name)) missing.push(part.name);
        continue;
      }
    } else v = values[part.name] ?? (part.kind === "ask" ? part.default : part.options[0]!);
    const how = part.mod ?? (mode === "shell" ? "shell" : mode === "url" ? "url" : "raw");
    out += how === "shell" ? shellQuote(v) : how === "url" ? encodeURIComponent(v) : v;
  }
  return { text: missing.length ? null : out, missing };
}

/** What the target and body make of values: an "open" body with a scheme is a URL. */
export function quickMode(target: QuickTarget, body: string, intoAgent: boolean): QuickMode {
  if (target === "open") return /^\s*[a-z][\w+.-]*:\/\//i.test(body) ? "url" : "text";
  return target === "type" && intoAgent ? "text" : "shell";
}

/** The environment a terminal run gets: CMD_QUICK_FILE, CMD_QUICK_SERVICE… (unquoted, so a script needs no parsing). */
export function quickEnv(p: QuickParsed, vars: Partial<Record<QuickVariable, string>>, values: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const key = (n: string) => `CMD_QUICK_${n.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  for (const n of p.vars) if (vars[n]) env[key(n)] = vars[n]!;
  for (const a of p.asks) env[key(a.name)] = values[a.name] ?? (a.kind === "ask" ? a.default : a.options[0]!);
  return env;
}

/** An id for a new command: its name as a slug, made unique among `taken`. */
export function quickId(name: string, taken: Iterable<string>): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40) || "command";
  const set = new Set(taken);
  let id = base;
  for (let n = 2; set.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The file's commands, checked: entries that aren't commands are left out and said so.
 * Unknown keys are kept (a newer cmd's), so a save doesn't drop them.
 */
export function readQuickCommands(v: unknown): { commands: QuickCommand[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(v)) return { commands: [], errors: ["expected a list of commands in [ ]"] };
  const commands: QuickCommand[] = [];
  const ids = new Set<string>();
  v.forEach((x, i) => {
    const at = `command ${i + 1}`;
    if (!x || typeof x !== "object" || Array.isArray(x)) return void errors.push(`${at}: expected { "name": …, "body": … }`);
    const c = x as Record<string, unknown>;
    if (typeof c.name !== "string" || !c.name.trim()) return void errors.push(`${at}: needs a "name"`);
    if (typeof c.body !== "string") return void errors.push(`${c.name}: needs a "body"`);
    if (c.target !== undefined && !QUICK_TARGETS.includes(c.target as QuickTarget)) return void errors.push(`${c.name}: "target" is one of ${QUICK_TARGETS.join(", ")}`);
    const keys = c.keys === undefined ? undefined : typeof c.keys === "string" ? [c.keys] : Array.isArray(c.keys) && c.keys.every((k) => typeof k === "string") ? (c.keys as string[]) : null;
    if (keys === null) return void errors.push(`${c.name}: "keys" is a shortcut or a list of them`);
    let id = typeof c.id === "string" && c.id.trim() ? c.id.trim() : quickId(c.name, ids);
    if (ids.has(id)) id = quickId(id, ids);
    ids.add(id);
    commands.push({ ...(c as object), id, name: c.name.trim(), body: c.body, ...(keys ? { keys } : {}) } as QuickCommand);
  });
  return { commands, errors };
}

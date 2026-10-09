// What the fast tier adds to Workspace Actions (docs/39, "AI"): a few words on
// what each action does, a better guess at its kind where the rules had none,
// which one is the folder's main action, and commands from the README that no
// file names. Short author descriptions are never rewritten (long ones are shortened), risk is never lowered,
// and the command is always shown under the words, so a wrong guess can't hide
// what runs.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ACTION_KINDS, type ActionKind, type WorkspaceAction } from "@cmd/protocol";
import { buildContext } from "../ai/context.ts";
import { matchAction } from "./history.ts";
import type { CompleteResult, ObjectRequest } from "../ai/backends.ts";
import type { CallOptions } from "../ai/service.ts";

export interface Described {
  /** Action id → what the model said about it. */
  actions: Record<string, { description: string; kind: ActionKind; long: boolean; risky: boolean }>;
  primary: string | null;
  suggested: { name: string; command: string; description: string }[];
}

/** Author descriptions longer than this are shortened by the model (it sees them). */
export const LONG_AUTHOR = 60;

export interface DescribeAi {
  object<T>(o: CallOptions & ObjectRequest<T>): Promise<CompleteResult<T>>;
}

/** Docs whose shell blocks say how to run the project. */
const DOCS = ["README.md", "readme.md", "README", "CONTRIBUTING.md", "DEVELOPMENT.md", "AGENTS.md", "CLAUDE.md"];

/** Fenced shell blocks from the folder's docs, under the heading they sit in. */
export function docCommands(root: string, max = 4000): string {
  const out: string[] = [];
  let size = 0;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return "";
  }
  // Exact names from the listing: the disk may be case-insensitive, and README.md is one file.
  for (const f of DOCS.filter((d) => names.includes(d))) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, f), "utf8");
    } catch {
      continue;
    }
    let heading = "";
    let fence: { lang: string; lines: string[] } | null = null;
    for (const line of text.split("\n")) {
      const open = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(line);
      if (fence) {
        if (!open || open[2]) {
          fence.lines.push(line);
          continue;
        }
        const body = fence.lines.join("\n").trim();
        // A shell block, or an untagged one that reads like a session ("$ make db").
        if (body && (/^(sh|bash|zsh|shell|console|terminal|shell-session)$/.test(fence.lang) || (!fence.lang && /^\$ /m.test(body)))) {
          const block = `${f} ${heading}\n${body}`;
          if (size + block.length > max) return out.join("\n\n");
          out.push(block);
          size += block.length;
        }
        fence = null;
      } else if (open) fence = { lang: open[2]!.toLowerCase(), lines: [] };
      else if (/^#{1,4} /.test(line)) heading = line.trim();
    }
  }
  return out.join("\n\n");
}

const SYSTEM = `You label the ways to run a software project for a quick-launch panel.

Every action gets a description. For each one, write it (if the author wrote one, shorten it to this form) of 2 to 6 words, a verb first, saying what it does for the developer, plain and specific: "Start the dev server", "Run unit tests once", "Ship a signed release", "Build the macOS app". Never repeat the action's name as its description, don't use "Runs"/"This", no full stop. If you can't tell, say what the command does literally ("Run scripts/stress.mjs").

kind: dev (servers, watchers, the app), test, build, check (lint, types, format), deploy (release, publish), setup (install, migrate, seed), clean, run (anything else), agent (only for agent skills and commands, which start a coding agent; keep it).
long: true only if it keeps running until someone stops it: a server, a watcher, an app window. A CLI, a build or a script that does its job and exits is false. Judge from what it runs, not its name.
risky: true if it publishes, deploys, pushes, or deletes or overwrites data.

primary: the id of the action a developer runs most to work on this project (usually starting the app or dev server), or null.

suggested: up to 5 commands from the docs that none of the actions already runs and that a developer would run again and again in this folder (not one-off installs of global tools, not cd/git/cat). Each with a short name and a description like above. [] if none.`;

const SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, description: { type: "string" }, kind: { type: "string", enum: [...ACTION_KINDS] }, long: { type: "boolean" }, risky: { type: "boolean" } },
        required: ["id", "description", "kind", "long", "risky"],
        additionalProperties: false,
      },
    },
    primary: { type: ["string", "null"] },
    suggested: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" }, command: { type: "string" }, description: { type: "string" } }, required: ["name", "command", "description"], additionalProperties: false },
    },
  },
  required: ["actions", "primary", "suggested"],
  additionalProperties: false,
} as const;

type Answer = { actions: { id: string; description: string; kind: string; long: boolean; risky: boolean }[]; primary: string | null; suggested: Described["suggested"] };

/** What the model is asked about: the actions it would see, and the docs. Changes → a new call. */
export function inputOf(root: string, actions: WorkspaceAction[]): { lines: string; docs: string; hash: string } {
  const shown = actions.filter((a) => !a.hidden).slice(0, 80);
  const lines = shown.map((a) => `- id: ${a.id}\n  name: ${a.name}${a.package ? `\n  package: ${a.package}` : ""}\n  command: ${a.command}${a.script ? `\n  runs: ${a.script.slice(0, 300)}` : ""}${a.description ? `\n  author says: ${a.description}` : ""}\n  from: ${a.source.file}\n  rules guess: ${a.kind}${a.long ? ", long" : ""}${a.risky ? ", risky" : ""}`).join("\n");
  const docs = docCommands(root);
  return { lines, docs, hash: createHash("sha256").update(`v2\0${root}\0${lines}\0${docs}`).digest("hex").slice(0, 24) };
}

export async function describe(ai: DescribeAi, root: string, actions: WorkspaceAction[], input = inputOf(root, actions)): Promise<Described> {
  const pkg = (() => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { description?: string }).description ?? "";
    } catch {
      return "";
    }
  })();
  const ctx = buildContext({
    purpose: "actions.describe",
    budget: 24_000,
    parts: [
      { name: "project", text: `Project folder: ${path.basename(root)}${pkg ? `\nAbout: ${pkg}` : ""}`, fixed: true },
      { name: "actions", text: `Actions:\n${input.lines}`, weight: 3 },
      { name: "docs", text: input.docs ? `Shell commands in the project's docs:\n${input.docs}` : "", weight: 1 },
    ],
  });
  const res = await ai.object<Answer>({ tier: "fast", purpose: "actions.describe", background: true, system: SYSTEM, prompt: ctx.text, schema: SCHEMA as unknown as Record<string, unknown>, effort: "minimal", maxOutputTokens: 4000, temperature: 0, context: ctx.record });
  const known = new Set(actions.map((a) => a.id));
  const out: Described = { actions: {}, primary: res.value.primary && known.has(res.value.primary) ? res.value.primary : null, suggested: [] };
  for (const a of res.value.actions ?? []) {
    if (!known.has(a.id) || !a.description?.trim()) continue;
    out.actions[a.id] = { description: a.description.trim().replace(/\.$/, "").slice(0, 80), kind: (ACTION_KINDS as readonly string[]).includes(a.kind) ? (a.kind as ActionKind) : "run", long: !!a.long, risky: !!a.risky };
  }
  for (const s of res.value.suggested ?? []) {
    const command = s.command?.trim().replace(/^\$\s+/, "");
    if (!command || command.includes("\n") || matchAction(actions, command, root) || out.suggested.length >= 5) continue;
    out.suggested.push({ name: s.name.trim().slice(0, 40) || command, command, description: s.description.trim().replace(/\.$/, "").slice(0, 80) });
  }
  return out;
}

/** What the model said per folder, so a restart or a second widget costs nothing. */
export class DescribedCache {
  #db: DatabaseSync | null;
  constructor(db: DatabaseSync | null) {
    this.#db = db;
    db?.exec(`CREATE TABLE IF NOT EXISTS workspace_actions_described (root TEXT PRIMARY KEY, hash TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL)`);
  }
  get(root: string): { hash: string; described: Described } | null {
    const row = this.#db?.prepare(`SELECT hash, json FROM workspace_actions_described WHERE root = ?`).get(root) as { hash: string; json: string } | undefined;
    if (!row) return null;
    try {
      return { hash: row.hash, described: JSON.parse(row.json) as Described };
    } catch {
      return null;
    }
  }
  set(root: string, hash: string, d: Described): void {
    this.#db?.prepare(`INSERT OR REPLACE INTO workspace_actions_described (root, hash, json, at) VALUES (?, ?, ?, ?)`).run(root, hash, JSON.stringify(d), Date.now());
  }
}

/** The actions with what the model said, where the file said nothing. */
export function applyDescribed(actions: WorkspaceAction[], d: Described | null): WorkspaceAction[] {
  if (!d) return actions;
  return actions.map((a) => {
    const m = d.actions[a.id];
    if (!m) return a;
    // The file's words, unless they're a paragraph (a script's header comment): then the model's short version of them.
    const own = a.describedBy === "cmd" || (a.describedBy === "author" && (a.description?.length ?? 0) <= LONG_AUTHOR);
    return {
      ...a,
      ...(own ? {} : { description: m.description, describedBy: "model" as const }),
      // The model knows what `node scripts/x.mjs` does better than a name rule; a source that set it knows best.
      kind: a.source.kind === "compose" || a.source.kind === "github" || a.kind === "agent" ? a.kind : m.kind === "agent" ? a.kind : m.kind,
      long: a.source.kind === "procfile" || a.source.kind === "compose" || a.kind === "agent" ? a.long : m.long,
      risky: a.kind === "agent" ? false : a.risky || m.risky,
    };
  });
}

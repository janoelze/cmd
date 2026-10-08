// Where an agent's name comes from without a model (docs/32-session-names.md,
// "Where names come from"): the worktree it works in. Sessions start in a
// repository's main checkout and move into a task's worktree later, so the
// folder is read from what the agent does (files it writes, `cd` and `git -C`
// in its commands, its reported cwd), not from where it started. A linked
// worktree on a branch that names something gives the name. Writing there is
// working there; going there may be a look at another agent's work, so it only
// names an agent that has no name yet.

import os from "node:os";
import path from "node:path";
import type { ActivityEvent, GitPlace } from "@cmd/protocol";
import { nameFromBranch } from "@cmd/protocol";
import { checkoutOf, placeOf } from "../checkout.ts";

const CD = /(?:^|&&|;|\|\||\()\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;
const GIT_C = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g;
/** `NAME=value` set in the command itself (`WT=/tmp/x && cd "$WT"`). */
const ASSIGN = /(?:^|&&|;|\|\||\(|\s)(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g;
const VAR = /\$(?:\{(\w+)\}|(\w+))/g;

/** Folders an event says the agent works in, most telling first: files it writes (`wrote`), then folders it goes to, then its cwd (`cwd`). */
export function foldersOf(ev: Pick<ActivityEvent, "cwd" | "tool">): { dir: string; wrote: boolean; cwd?: true }[] {
  const out: { dir: string; wrote: boolean; cwd?: true }[] = [];
  const cmd = ev.tool?.command ?? "";
  const vars = new Map<string, string>([["HOME", os.homedir()]]);
  // Unknown variables leave the path out rather than guess.
  const expand = (p: string): string | null => {
    if (p.startsWith("'")) return p.slice(1, -1);
    let unknown = false;
    const out = p.replace(/^"|"$/g, "").replace(VAR, (_, a: string | undefined, b: string | undefined) => vars.get((a ?? b)!) ?? ((unknown = true), ""));
    return unknown ? null : out;
  };
  for (const m of cmd.matchAll(ASSIGN)) {
    const v = expand(m[2]!);
    if (v !== null) vars.set(m[1]!, v);
  }
  // Tool paths are file names as they are; command arguments are shell words.
  const abs = (p: string, shell = false) => {
    const unq = shell ? expand(p) : p.replace(/^["']|["']$/g, "");
    if (unq === null) return null;
    const home = unq === "~" || unq.startsWith("~/") ? path.join(os.homedir(), unq.slice(1)) : unq;
    if (path.isAbsolute(home)) return home;
    return ev.cwd ? path.join(ev.cwd, home) : null;
  };
  for (const p of ev.tool?.paths ?? []) {
    const a = abs(p);
    if (a) out.push({ dir: path.dirname(a), wrote: true });
  }
  for (const re of [CD, GIT_C]) for (const m of cmd.matchAll(re)) {
    const a = abs(m[1]!, true);
    if (a) out.push({ dir: a, wrote: false });
  }
  if (ev.cwd) out.push({ dir: ev.cwd, wrote: false, cwd: true });
  return out;
}

/** The name the worktree an event points at gives, with that worktree; null when it points at none (or a main checkout). */
export function worktreeName(ev: Pick<ActivityEvent, "cwd" | "tool">): { name: string; top: string; branch: string; wrote: boolean } | null {
  for (const { dir, wrote } of foldersOf(ev)) {
    const c = checkoutOf(dir);
    // The main checkout (its git folder is the shared one) is where every task starts, not a task.
    if (!c || c.gitDir === c.common || !c.branch) continue;
    const name = nameFromBranch(c.branch);
    if (name) return { name, top: c.top, branch: c.branch, wrote };
  }
  return null;
}

/**
 * The checkout an event moves the agent to (docs/35): the first one it writes
 * in, else the first one it goes to (`cd`, `git -C`). Its cwd alone moves
 * nothing: agents keep the cwd they started in. null when the event points at
 * no checkout.
 */
export function placeFrom(ev: Pick<ActivityEvent, "cwd" | "tool">): { at: GitPlace; wrote: boolean } | null {
  for (const { dir, wrote, cwd } of foldersOf(ev)) {
    if (cwd) break;
    const at = placeOf(dir);
    if (at) return { at, wrote };
  }
  return null;
}

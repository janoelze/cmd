// Peer briefings (beta, `agents.peers`): tell an agent which other agents work in
// the same repository (any of its worktrees) and how to message them, so they
// find each other before their work collides. Injected by `cmd hook` as context
// at SessionStart, and again on a prompt when the set of peers changed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "@cmd/protocol";
import { checkoutOf as readCheckout } from "../checkout.ts";

export interface Checkout {
  /** The repository's shared .git folder: equal for all worktrees of one repo. */
  repo: string;
  /** This worktree's top level. */
  root: string;
  branch: string | null;
}

/** The checkout `dir` is in (checkout.ts), keyed by the real path of its shared .git; null outside a repository. */
export function checkoutOf(dir: string): Checkout | null {
  const c = readCheckout(dir);
  if (!c) return null;
  try {
    return { repo: fs.realpathSync(c.common), root: c.top, branch: c.branch };
  } catch {
    return null;
  }
}

const tilde = (p: string) => (p.startsWith(os.homedir() + "/") ? "~" + p.slice(os.homedir().length) : p);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ago = (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

/** The briefing for `self`, given its peers' checkouts; null when there are none. */
export function briefing(self: { agent: Agent; at: Checkout }, peers: { agent: Agent; at: Checkout }[], now = Date.now()): string | null {
  if (!peers.length) return null;
  const label = (a: Agent) => `${a.name ? `${a.name} ` : ""}(${a.kind}, id ${a.id.slice(0, 8)})`;
  const lines = peers.map(({ agent: a, at }) => {
    const where = at.root === self.at.root ? "same checkout as you" : tilde(at.root);
    const task = a.lastPrompt ?? a.spawn.prompt;
    return [
      `- ${label(a)}: ${a.state} for ${ago(now - a.stateSince)}, ${where}${at.branch ? ` on ${at.branch}` : ""}`,
      task ? `, working on "${short(task.split("\n")[0]!, 120)}"` : "",
      a.detail ? `; now: ${short(a.detail, 60)}` : "",
    ].join("");
  });
  return [
    `[cmd] Other agents are working in this repository in parallel with you. You are ${label(self.agent)}.`,
    ...lines,
    `Avoid changing what they are working on. If your work overlaps theirs, or touches shared state (a checkout they use, merges, releases, running servers), message them first: cmd send <id> "[from <your id>, an agent] <message>". It arrives in their terminal as a prompt; keep it short. \`cmd ls\` lists agents now. You may be told again here when agents come or go.`,
  ].join("\n");
}

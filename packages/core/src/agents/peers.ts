// Peer briefings (beta, `agents.peers`): tell an agent which other agents work in
// the same repository (any of its worktrees) and how to message them, so they
// find each other before their work collides. Injected by `cmd hook` as context
// at SessionStart, and again on a prompt when the set of peers changed.

import os from "node:os";
import type { Agent, GitPlace } from "@cmd/protocol";

const tilde = (p: string) => (p.startsWith(os.homedir() + "/") ? "~" + p.slice(os.homedir().length) : p);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ago = (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

/** The briefing for `self`, given where it and its peers work (Agent.git); null when there are no peers. */
export function briefing(self: { agent: Agent; at: GitPlace }, peers: { agent: Agent; at: GitPlace }[], now = Date.now()): string | null {
  if (!peers.length) return null;
  const label = (a: Agent) => `${a.name ? `${a.name} ` : ""}(${a.kind}, id ${a.id.slice(0, 8)})`;
  const lines = peers.map(({ agent: a, at }) => {
    const where = at.top === self.at.top ? "same checkout as you" : tilde(at.top);
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

// The workspace brief (docs/51, The system prompt): what the Operator knows about a workspace
// when a conversation starts, so its first answer needn't begin with orientation. Summaries,
// never raw events: where the folder is in git, how to run it, what the journal says today, and
// the event counts the events tool gives.

import { TOOLS, type ToolContext } from "../tools/index.ts";

const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

export async function workspaceBrief(b: ToolContext): Promise<string> {
  const ws = b.workspace();
  const parts: string[] = [];
  if (ws.home) parts.push("This is the Home workspace: the person's home folder, not a project. Before starting agents, running or editing anything, ask which project folder they mean (or use the folder they named).");
  const git = await safe(() => b.call("git.status", { path: ws.root }));
  if (git) {
    const n = Object.keys(git.files).length;
    parts.push(`Git: branch ${git.branch ?? "(detached)"}${git.upstream ? `, ${git.ahead} ahead and ${git.behind} behind ${git.upstream}` : ""}; ${n ? `${n}${git.truncated ? "+" : ""} changed files` : "nothing uncommitted"}.`);
  }
  const actions = await safe(() => b.call("actions.list", { workspaceId: ws.id }));
  if (actions?.actions.length) {
    const shown = actions.actions.filter((a) => !a.hidden).slice(0, 40);
    parts.push(`Workspace Actions (run them with run):\n${shown.map((a) => `- ${a.name}: ${a.command}${a.description ? ` (${a.description})` : ""}${a.risky ? " [risky: asks first]" : ""}${a.long ? " [keeps running]" : ""}`).join("\n")}`);
  } else parts.push("No Workspace Actions found.");
  const day = await safe(() => b.call("journal.day", { workspaceId: ws.id, date: workDay(), write: "never" }));
  if (day?.entries.length) parts.push(`Today so far (the journal): ${day.headline}\n${day.entries.slice(0, 8).map((e) => `- ${e.title}: ${e.summary}`).join("\n")}`);
  const events = TOOLS.find((t) => t.spec.name === "events");
  const counts = events ? await safe(() => events.run({ hours: 8 }, b)) : null;
  if (counts) parts.push(counts.replace(/\nAsk for rows.*$/, ""));
  return parts.join("\n\n");
}

/** Local midnight of today's work day (it runs 04:00 to 04:00, as the journal's). */
export function workDay(now = new Date()): number {
  const d = new Date(now.getTime() - 4 * 3600_000);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}


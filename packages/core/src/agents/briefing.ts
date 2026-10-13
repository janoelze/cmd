// What an agent in a cmd pane is told at session start (Agent integration, `agents.integration`,
// docs/54): that it runs in cmd, its pane and workspace, how to reach cmd, and the peer
// briefing (peers.ts). Plain facts, not imperatives, well under the agents' limits for hook
// context. Handed out by hook.ingest; on a prompt only the peers, and only when they changed.

import os from "node:os";
import type { Agent, AgentId, Pane, Workspace } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";

const tilde = (p: string) => (p === os.homedir() ? "~" : p.startsWith(os.homedir() + "/") ? "~" + p.slice(os.homedir().length) : p);

/** The lines that say where the agent runs; `tools`: how it reaches cmd's tools (the CLI until the MCP server is registered). */
export function introduction(agent: Agent, pane: Pane | null, workspace: Workspace | null, tools = "`cmd --help` in the shell lists them"): string {
  const where = [
    pane ? `Pane: ${pane.id}${agent.name ? `, named "${agent.name}"` : ""}.` : null,
    workspace ? `Workspace: "${workspace.name}" (${tilde(workspace.root)}).` : null,
  ].filter(Boolean);
  return [
    "[cmd] You are running in a terminal pane of cmd, a macOS workspace for terminals and coding agents.",
    ...(where.length ? [where.join(" ")] : []),
    `cmd can open windows and browsers beside you, start and message other agents and wait for them, read other panes and arrange the board: ${tools}. You are agent id ${agent.id.slice(0, 8)}.`,
  ].join("\n");
}

/** The context for a hook to hand agent `id` at `event` (normalised, hookEventName); null: nothing to say. */
export function agentBriefing(core: Pick<CoreContext, "agents" | "panes" | "workspaces" | "settings">, id: AgentId, event: string): string | null {
  if (!core.settings.settings["agents.integration"]) return null;
  const peers = core.agents.peerBriefing(id, event);
  if (event !== "SessionStart") return peers;
  const agent = core.agents.get(id);
  if (!agent) return peers;
  const pane = agent.paneId ? (core.panes.get(agent.paneId) ?? null) : null;
  const intro = introduction(agent, pane, core.workspaces.get(pane?.workspaceId ?? agent.workspaceId) ?? null);
  return peers ? `${intro}\n\n${peers}` : intro;
}

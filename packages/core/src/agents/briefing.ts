// What an agent in a cmd pane is told at session start (Agent integration, `agents.integration`,
// docs/54): that it runs in cmd, its pane and workspace, how to reach cmd, and the peer
// briefing (peers.ts). Plain facts, not imperatives, well under the agents' limits for hook
// context. Handed out by hook.ingest; on a prompt only the peers when they changed, and what the
// agent started through cmd's tools reporting back (tools/reports.ts).

import os from "node:os";
import type { Agent, AgentId, Pane, Workspace } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import { toolsOf } from "../tools/feature.ts";
import { reportsText } from "../tools/reports.ts";

const tilde = (p: string) => (p === os.homedir() ? "~" : p.startsWith(os.homedir() + "/") ? "~" + p.slice(os.homedir().length) : p);

/** How an agent reaches cmd's tools: the MCP server where it is in the agent's config, else the CLI. */
const TOOLS_MCP = 'they are the "cmd" MCP server\'s tools (`cmd tools` in the shell lists the same)';
const TOOLS_CLI = "`cmd tools` in the shell lists them and `cmd tool NAME '<json>'` runs one";

/** The lines that say where the agent runs, and how it reaches cmd's tools (`mcp`: through the MCP server). */
export function introduction(agent: Agent, pane: Pane | null, workspace: Workspace | null, mcp = false): string {
  const tools = mcp ? TOOLS_MCP : TOOLS_CLI;
  const where = [
    pane ? `Pane: ${pane.id}${agent.name ? `, named "${agent.name}"` : ""}.` : null,
    workspace ? `Workspace: "${workspace.name}" (${tilde(workspace.root)}).` : null,
  ].filter(Boolean);
  return [
    "[cmd] You are running in a terminal pane of cmd, a macOS workspace for terminals and coding agents.",
    ...(where.length ? [where.join(" ")] : []),
    `cmd can show the person files, folders and web pages in windows beside you, start and message other agents and wait for them, read other terminals and arrange the board: ${tools}. You are agent id ${agent.id.slice(0, 8)}.`,
  ].join("\n");
}

/** The context for a hook to hand agent `id` at `event` (normalised, hookEventName); null: nothing to say. */
export function agentBriefing(core: CoreContext, id: AgentId, event: string): string | null {
  if (!core.settings.settings["agents.integration"]) return null;
  const peers = core.agents.peerBriefing(id, event);
  const agent = core.agents.get(id);
  if (event !== "SessionStart") {
    const reports = event === "UserPromptSubmit" && agent?.paneId ? reportsText(toolsOf(core).reports.take(agent.paneId)) : "";
    return [peers, reports && `[cmd] ${reports}`].filter(Boolean).join("\n\n") || null;
  }
  if (!agent) return peers;
  const pane = agent.paneId ? (core.panes.get(agent.paneId) ?? null) : null;
  const intro = introduction(agent, pane, core.workspaces.get(pane?.workspaceId ?? agent.workspaceId) ?? null, core.agentSetup.serves(agent.kind));
  return peers ? `${intro}\n\n${peers}` : intro;
}

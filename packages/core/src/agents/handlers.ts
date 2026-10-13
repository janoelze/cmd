// The agents' methods (agent.*, agents.*, hook*): spawn, talk to, wait for and end agents,
// what cmd recorded about them, and cmd's hook in their configs.

import os from "node:os";
import type { ActivityExportHeader } from "@cmd/protocol";
import { EXPORT_FORMAT, TURN_FORMAT } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import { IN_CORE, slice } from "../kernel/handlers.ts";
import { rewrite } from "./activity/fixture.ts";
import { agentBriefing } from "./briefing.ts";
import { hookEventName } from "./state.ts";
import { eventId } from "../data/ids.ts";

export const agentHandlers = (core: CoreContext) =>
  slice({
    "agent.list": () => core.agents.list(),
    "agent.spawn": (p) => {
      const workspace = core.place(p, { parentId: p.parentId, path: p.cwd });
      const parent = p.parentId ? core.agents.get(p.parentId) : null;
      return core.agents.spawn({ ...p, workspaceId: workspace.id, cwd: p.cwd ?? parent?.cwd ?? workspace.root });
    },
    "agent.send": async (p, { conn } = IN_CORE) => {
      await core.agents.send(p.agentId, p.text, p.submit);
      const paneId = conn && conn.access !== "local" ? core.agents.get(p.agentId)?.paneId : null;
      if (conn && paneId) core.remote.input(conn, paneId);
      return null;
    },
    "agent.wait": (p) => core.agents.wait(p.agentIds, p.until, p.mode, p.timeoutMs),
    "agent.kill": (p) => ({ killed: core.agents.kill(p.agentId, p.tree) }),
    "agent.rename": (p) => core.agents.rename(p.agentId, p.name),
    "agent.markSeen": (p) => {
      core.agents.markSeen(p.agentId);
      const a = core.agents.get(p.agentId);
      core.data.record({ id: eventId("user.look"), at: Date.now(), type: "user.look", source: "user", agentId: p.agentId, paneId: a?.paneId ?? null, workspaceId: a?.workspaceId ?? null, data: { agentId: p.agentId } });
      return null;
    },
    "agent.summarize": async (p) => {
      const s = await core.summaries.start(p.agentId, { open: p.open });
      return { path: s.path, windowId: s.windowId, markdown: p.wait ? await s.done : null };
    },
    "agent.resumeCommand": (p) => core.agents.resumeCommand(p.agentId),
    "agent.resume": (p) => core.agents.resume({ ...p, workspaceId: core.place(p, { path: p.cwd ?? undefined }).id }),
    "agents.coverage": (p) => core.agents.activity.coverage(p.days),
    "agents.export": (p) => {
      const log = core.agents.activity;
      const since = Date.now() - (p.days ?? 14) * 86400_000;
      const limit = Math.min(p.limit ?? 2000, 10_000);
      const events = log.events({ since, afterId: p.afterId, limit: limit + 1, raw: true, oldest: true });
      const more = events.length > limit;
      const page = more ? events.slice(0, limit) : events;
      const turns = p.afterId ? [] : log.turnsSince(since).map((t) => t.turn);
      const header: ActivityExportHeader = { format: "cmd-agent-activity", version: EXPORT_FORMAT, schema: log.schemaVersion(), turnFormat: TURN_FORMAT, exportedAt: Date.now(), cmd: log.recordedBy, since, anonymized: !!p.anonymize };
      const anon = <T,>(v: T): T => (p.anonymize ? (rewrite(v, [[os.homedir(), "~"]]) as T) : v);
      return { header, turns: anon(turns), events: anon(page), next: more ? page.at(-1)!.id : null };
    },
    "agents.homes": (p) => {
      if (p.rescan || !core.agentSetup.discovered) core.agentSetup.discover();
      return core.homes.all();
    },
    "hook.ingest": (p) => {
      const event = hookEventName(p.agent, p.event);
      const agentId = core.agents.ingestHook(p.paneId, p.agent, event, p.payload, p.spooled)?.id ?? null;
      const context = agentId ? agentBriefing(core, agentId, event) : null;
      return context ? { agentId, context } : { agentId };
    },
    "hooks.status": () => core.agentSetup.targets(),
    "hooks.install": (p) => core.agentSetup.install(p.file),
    "hooks.remove": (p) => core.agentSetup.remove(p.file),
    identify: (p) => {
      const pane = core.panes.get(p.paneId);
      return { pane, agent: pane?.agentId ? core.agents.get(pane.agentId) : null };
    },
  });

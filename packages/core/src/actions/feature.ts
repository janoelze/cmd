// Workspace Actions as one feature (docs/39-workspace-actions.md; kernel/features.ts): the
// service, built from the core's, its RPC methods and its teardown. Its settings are
// ACTIONS_SETTINGS and its methods ActionsMethods (protocol actions.ts).

import path from "node:path";
import type { ActionsMethods, WorkspaceId } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import type { HandlerSlice } from "../kernel/handlers.ts";
import { projectIdOf } from "../data/project.ts";
import { expandHome } from "../windows/builtin.ts";
import { ActionsService } from "./service.ts";

/** The folder Workspace Actions are for: a path given, else the workspace's root. */
export function actionsRoot(core: Pick<CoreContext, "workspaces">, p: string | undefined, workspaceId: WorkspaceId | undefined): string {
  if (p) return path.resolve(expandHome(p));
  return (workspaceId ? core.workspaces.get(workspaceId)?.root : undefined) ?? core.workspaces.home().root;
}

/** The service (`core.actions`), with what it tells the app and when it describes again. */
export function createActions(core: Pick<CoreContext, "panes" | "store" | "data" | "ai" | "settings" | "windows" | "agents" | "workspaces" | "usage" | "broadcast" | "opened">): ActionsService {
  const actions = new ActionsService({
    panes: core.panes,
    db: core.store.db,
    commands: (root, since) => {
      const projectId = projectIdOf(root);
      if (!projectId) return [];
      return core.data.query({ types: ["command"], projectId, at: [since, Date.now() + 1], by: "time", order: "desc", limit: 5000 }).flatMap((e) => {
        const d = e.data as { command?: string | null; cwd?: string; exitCode?: number | null };
        return d.command && d.cwd ? [{ command: d.command, cwd: d.cwd, at: e.at, exitCode: d.exitCode ?? null }] : [];
      });
    },
    ai: { object: (o) => core.ai.object(o), ready: () => core.ai.status().ready },
    describeOn: () => core.settings.settings["actions.describe"],
    roots: () => core.windows.list().flatMap((w) => (w.kind === "actions" ? [actionsRoot(core, w.state.path as string | undefined, w.workspaceId)] : [])),
    agentsIn: (top) => core.agents.list().filter((a) => a.git?.top === top && a.state !== "exited").length,
    agentCommand: (agent) => {
      const v = (core.settings.settings as Record<string, unknown>)[`agents.${agent}.command`];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    },
    createPane: (o) => {
      const pane = core.panes.create({ cwd: o.cwd, command: o.command, workspaceId: core.workspaces.mustOpen(o.workspaceId).id });
      core.usage.window("terminal");
      return pane;
    },
  });
  actions.on("changed", (root) => core.broadcast({ type: "actions.changed", root }));
  // A dev server said where it listens: open it beside its terminal, once, if asked to.
  actions.on("url", (paneId, url) => {
    const pane = core.panes.get(paneId);
    // Output still in flight from a workspace that just closed opens nothing.
    const ws = pane && core.workspaces.get(pane.workspaceId);
    if (!ws || ws.closedAt !== null || !core.settings.settings["actions.openBrowser"]) return;
    if (core.windows.list().some((w) => w.kind === "browser" && w.workspaceId === ws.id && typeof w.state.url === "string" && w.state.url.startsWith(url.replace(/\/$/, "")))) return;
    core.opened(core.windows.open("browser", { url }, ws, undefined, paneId));
  });
  core.data.onForget(({ what }) => void (what.projectId?.startsWith("dir:") && actions.forgetProject(what.projectId.slice(4))));
  core.settings.bind(["actions.describe"], () => actions.aiChanged());
  core.ai.on("updated", () => actions.aiChanged());
  return actions;
}

export const actionsFeature = {
  id: "actions",
  handlers: (core: CoreContext): HandlerSlice<keyof ActionsMethods> => ({
    "actions.list": (p) => core.actions.list(actionsRoot(core, p.path, p.workspaceId)),
    "actions.run": (p) => core.actions.run(p.root, p.actionId, core.place({ workspaceId: p.workspaceId }, { path: p.root }).id, { restart: p.restart, fresh: p.fresh, confirmed: p.confirmed }),
    "actions.stop": (p) => (core.actions.stop(p.root, p.actionId), null),
    "actions.pin": (p) => (core.actions.pin(p.root, p.actionId, p.pinned), null),
  }),
  dispose: (core: CoreContext) => core.actions.dispose(),
} satisfies Feature;

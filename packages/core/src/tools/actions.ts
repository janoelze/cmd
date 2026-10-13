// Running a Workspace Action (docs/39) by name: the project's own commands in a terminal of
// their own; a risky one asks first. What it starts reports back to the caller when it ends.

import type { WorkspaceAction } from "@cmd/protocol";
import { schema, type ToolContext, type Tool } from "./kit.ts";

async function actionByName(b: ToolContext, name: string): Promise<{ root: string; action: WorkspaceAction }> {
  const list = await b.call("actions.list", { workspaceId: b.workspace().id });
  const all = [...list.actions, ...list.history];
  const a = all.find((x) => x.id === name) ?? all.find((x) => x.name === name && !x.package) ?? all.find((x) => x.name === name);
  if (!a) throw new Error(`no action "${name}". The workspace's actions: ${list.actions.slice(0, 30).map((x) => x.name).join(", ") || "none"}`);
  return { root: list.root, action: a };
}

const runTool: Tool = {
  acts: true,
  calls: ["actions.list", "actions.run"],
  spec: {
    name: "run",
    explores: false,
    description:
      "Run one of the workspace's actions by name: the project's own commands (package.json scripts, make targets, just recipes…) in a terminal of their own, which the board shows. The preferred way to run anything: use it whenever an action fits, `type` only when none does. Risky ones (deploys, publishes) ask the person first. With `list: true` it only lists the actions. Returns at once with the terminal's ref; it reports back by itself when it ends (with its status), and a server's address once it prints one.",
    schema: schema({ name: { type: "string", description: "The action's name, as listed (\"test\", \"dev\", \"build\")." }, list: { type: "boolean" }, restart: { type: "boolean", description: "Restart it if it is already running (a dev server)." } }),
  },
  async confirm(i, b) {
    if (i.list) return null;
    const { action } = await actionByName(b, String(i.name ?? ""));
    // A risky one asks every time, kept at most for the session, and by the action itself.
    return action.risky ? { permission: "run", title: `Run “${action.name}”, which is risky`, exact: action.command, risky: true, site: action.name } : { permission: "run", title: `Run “${action.name}”`, exact: action.command };
  },
  async run(i, b) {
    if (i.list) {
      const list = await b.call("actions.list", { workspaceId: b.workspace().id });
      const fmt = (a: WorkspaceAction) => `${a.name}: ${a.command}${a.description ? ` (${a.description})` : ""}${a.risky ? " [risky]" : ""}${a.long ? " [keeps running]" : ""}`;
      return list.actions.length ? list.actions.filter((a) => !a.hidden).map(fmt).join("\n") : "This workspace has no actions.";
    }
    const { root, action } = await actionByName(b, String(i.name ?? ""));
    // Reaching here, a risky one was allowed (confirm above).
    const r = await b.call("actions.run", { root, actionId: action.id, workspaceId: b.workspace().id, restart: !!i.restart, confirmed: action.risky });
    const label = `“${action.name}” (${action.command})`;
    if (!r.started) {
      const run = (await b.call("actions.list", { workspaceId: b.workspace().id })).runs.find((x) => x.paneId === r.paneId && x.actionId === action.id);
      return `${label} is already running in ${b.refs.of(r.paneId)}${run?.url ? `, at ${run.url}` : ""}.`;
    }
    b.started?.command(r.paneId, label);
    b.opened?.add(r.paneId);
    return `Started ${label} in ${b.refs.of(r.paneId)}. You'll be told when it ends${action.long ? ", and its address once it prints one (it keeps running)" : ""}.`;
  },
};

export const ACTION_TOOLS: Tool[] = [runTool];

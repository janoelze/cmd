// The tools as one feature (docs/54; kernel/features.ts): what every caller of the tools shares
// in a core (the approvals, waiting and remembered), running them for agents in panes (runner.ts,
// reports.ts), and the methods for both (ToolsMethods, protocol tools.ts). Made with the first
// use, one per core.

import { PERMISSIONS, approvalKey, approvalLabel, type DeniedCall, type Permission, type PermissionLevel, type ToolActivity, type ToolsMethods } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import type { HandlerSlice } from "../kernel/handlers.ts";
import { Approvals } from "./approvals.ts";
import { Reports } from "./reports.ts";
import { ToolRunner } from "./runner.ts";

export interface ToolsService {
  approvals: Approvals;
  reports: Reports;
  runner: ToolRunner;
  /** A call on the board, whoever made it: broadcast (tool.acting), and kept while it runs or waits. */
  show(a: ToolActivity): void;
  /** Calls waiting for the person now. */
  waiting(): ToolActivity[];
}

const services = new WeakMap<CoreContext, ToolsService>();

/** The core's tools service, made on first use. */
export function toolsOf(core: CoreContext): ToolsService {
  let s = services.get(core);
  if (!s) {
    const approvals = new Approvals(core.store.db, () => levels(core));
    let runner: ToolRunner | null = null;
    const reports = new Reports(core, (caller, id) => runner!.refs(caller).of(id));
    const shown = new Map<string, ToolActivity>();
    const show = (a: ToolActivity) => {
      if (a.state === "running" || a.state === "waiting") shown.set(a.id, a);
      else shown.delete(a.id);
      core.broadcast({ type: "tool.acting", call: a });
    };
    runner = new ToolRunner(core, approvals, reports, show);
    services.set(core, (s = { approvals, reports, runner, show, waiting: () => [...shown.values()].filter((a) => a.state === "waiting") }));
  }
  return s;
}

/** Each permission's level, from Settings → Agents → Permissions. */
const levels = (core: Pick<CoreContext, "settings">) => Object.fromEntries(PERMISSIONS.map((p) => [p.id, core.settings.settings[`agents.permissions.${p.id}`] as PermissionLevel])) as Record<Permission, PermissionLevel>;

/** Calls the person said no to lately, from the log (tool.call, denied). */
function denied(core: Pick<CoreContext, "data">, limit: number): DeniedCall[] {
  return core.data.query({ types: ["tool.call"], by: "time", order: "desc", limit: 500 }).flatMap((e) => {
    const d = e.data as { state?: string; caller?: string; ask?: string | null; reason?: string | null; permission?: Permission | null; site?: string | null; widget?: string };
    // A widget's denial has no "Allow from now on": that would allow the kind of act for agents, not for the widget (its own yes is kept from its sheet).
    return d.state === "denied" && e.workspaceId ? [{ id: e.id, at: e.at, workspaceId: e.workspaceId, caller: d.caller ?? "An agent", title: d.ask ?? e.text ?? "", reason: d.reason ?? null, permission: d.widget ? null : (d.permission ?? null), site: d.site ?? null }] : [];
  }).slice(0, limit);
}

export const toolsFeature = {
  id: "tools",
  prefixes: ["tools", "approvals"],
  handlers: (core: CoreContext): HandlerSlice<keyof ToolsMethods> => ({
    "tools.list": (p) => toolsOf(core).runner.list(p),
    "tools.call": (p) => toolsOf(core).runner.call(p),
    "approvals.waiting": () => toolsOf(core).waiting(),
    "approvals.answer": (p) => (toolsOf(core).approvals.answer(p.workspaceId, p.itemId, { allow: p.allow, reason: p.reason, scope: p.scope }), null),
    "approvals.list": (p) => toolsOf(core).approvals.list(p.workspaceId),
    "approvals.allow": (p) => (toolsOf(core).approvals.remember(p.workspaceId, approvalKey(p.permission, p.site), approvalLabel(p.permission, p.site)), null),
    "approvals.denied": (p) => denied(core, Math.min(p.limit ?? 20, 100)),
    "approvals.forget": (p) => (toolsOf(core).approvals.forget(p.workspaceId, p.key), null),
  }),
} satisfies Feature;

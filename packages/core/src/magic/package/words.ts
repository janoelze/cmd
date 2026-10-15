// What a widget package asks for, in words, for the core's side of the permission step
// ("Wants to reach api.github.com and see this workspace"): the same words as the grants
// sheet's lines (renderer windows/package/grants.ts), short.

import type { WidgetPermissions } from "@cmd/protocol";

const ACT: Record<string, string> = { actions: "run Workspace Actions", agents: "start and message agents", terminals: "type in terminals", windows: "open and close windows" };

/** One phrase per permission, lowercase. */
export function permissionLines(p: WidgetPermissions): string[] {
  const out: string[] = [];
  if (p.net.length) out.push(`reach ${p.net.join(", ")}`);
  if (p.run.length) out.push(`run ${p.run.join(", ")}`);
  if (p.read.length) out.push(`read ${p.read.join(", ")}`);
  if (p.workspace.includes("all")) out.push("see every workspace");
  else if (p.workspace.includes("read")) out.push("see this workspace");
  if (p.events.length) out.push(`read ${p.events.join(", ")} events`);
  for (const ns of new Set(p.act.map((a) => a.split(".")[0]!))) out.push(ns === "actions" && p.act.some((a) => a === "actions" || a === "actions.stop") ? "run and stop Workspace Actions" : (ACT[ns] ?? `use ${ns}`));
  if (p.ai.length) out.push("use your AI");
  if (p.media.includes("control")) out.push("see and control what's playing");
  else if (p.media.includes("read")) out.push("see what's playing");
  return out;
}

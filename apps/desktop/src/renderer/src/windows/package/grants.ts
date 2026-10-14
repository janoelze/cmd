// What a widget package asks for, in words a person reads (docs/56, "Capabilities and grants"):
// one line per permission for the grants sheet (GrantSheet.tsx), with an icon, and "New" on what
// a grant it has doesn't cover (a version asking for more); and where the package comes from.

import type { WidgetEntry, WidgetPermissions } from "@cmd/protocol";

export interface PermissionLine {
  /** SF Symbol name. */
  icon: string;
  label: string;
  /** Not in the grant it has (a new version asking for more). */
  added: boolean;
}

/** What acting on each part of cmd asks, in words. */
const ACT: Record<string, string> = {
  actions: "Run Workspace Actions, asking first",
  agents: "Start and message agents, asking first",
  terminals: "Type in terminals, asking first",
  windows: "Open and close windows, asking first",
};

/** Each permission of `declared` as a line; `granted` (the grant it has) marks the new ones. */
export function permissionLines(declared: WidgetPermissions, granted: WidgetPermissions | null = null): PermissionLine[] {
  const out: PermissionLine[] = [];
  const isNew = (k: keyof WidgetPermissions, ...values: string[]) => !!granted && values.every((v) => !granted[k].includes(v));
  for (const h of declared.net) out.push({ icon: "globe", label: `Reach ${h}`, added: isNew("net", h) });
  for (const p of declared.run) out.push({ icon: "terminal", label: `Run ${p}`, added: isNew("run", p) });
  for (const f of declared.read) out.push({ icon: "folder", label: `Read ${f}`, added: isNew("read", f) });
  const all = declared.workspace.includes("all");
  if (all || declared.workspace.includes("read"))
    out.push({ icon: "rectangle.3.group", label: `See the agents, terminals and windows of ${all ? "every workspace" : "this workspace"}`, added: isNew("workspace", all ? "all" : "read") });
  for (const c of declared.events) out.push({ icon: "doc.text", label: `Read ${c} events`, added: isNew("events", c) });
  const acts = new Map<string, string[]>();
  for (const a of declared.act) {
    const ns = a.split(".")[0]!;
    acts.set(ns, [...(acts.get(ns) ?? []), a]);
  }
  for (const [ns, values] of acts) out.push({ icon: "bolt", label: ACT[ns] ?? `Use ${ns}, asking first`, added: isNew("act", ...values) });
  if (declared.ai.length) out.push({ icon: "sparkles", label: "Use your AI, counts against your usage", added: isNew("ai", ...declared.ai) });
  return out;
}

/** Where a package comes from: "Linked from ~/src/my-widget", "Installed in ~/.cmd/widgets". */
export function sourceLine(e: Pick<WidgetEntry, "link" | "dir">, short: (p: string) => string): string {
  if (e.link) return `Linked from ${short(e.link)}`;
  const folder = e.dir ? e.dir.slice(0, e.dir.lastIndexOf("/")) : "";
  return folder ? `Installed in ${short(folder)}` : "Installed";
}

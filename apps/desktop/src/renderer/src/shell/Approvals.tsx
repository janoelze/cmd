// The approval sheet in the app (docs/55): the oldest tool call waiting for the person, from any
// workspace, opens at once over the window; "1 of 3" when more wait. How long a yes holds is a
// switch in its footer (Once, This Session, Always, where the call offers them); Return allows,
// Esc denies (lib/asks.ts, the kit's ApprovalSheet). A widget's act (docs/56, phase 4) names the
// widget, its package and version; a yes is kept for that package alone.

import { ApprovalSheet, Presence } from "@cmd/ui";
import { permissionOf, type ApprovalScope, type ToolActivity } from "@cmd/protocol";
import { answerAsk, useAsks } from "../lib/asks.ts";
import { useStoreValue } from "../lib/store.ts";

export function Approvals() {
  const asks = useAsks();
  return <Presence when={asks[0]}>{(a, open) => <Ask key={a.id} ask={a} open={open} count={asks.length} />}</Presence>;
}

function Ask({ ask, open, count }: { ask: ToolActivity; open: boolean; count: number }) {
  const workspace = useStoreValue((s) => s.workspaces.get(ask.workspaceId)?.name ?? null);
  const a = ask.approval!;
  const bySite = permissionOf(a.permission)?.bySite && a.site;
  // How long a yes holds: short choices, what each covers in its tooltip.
  const where = workspace ? ` in “${workspace}”` : "";
  const settings = "Change it in Settings → AI & Agents → Permissions.";
  const w = a.widget;
  const scope: Record<ApprovalScope, { label: string; detail: string }> = {
    once: { label: "Once", detail: "Asks again next time." },
    session: { label: "This Session", detail: w ? "While this widget runs." : a.risky ? `Until ${ask.caller} exits. Risky actions are never allowed for always.` : `Until ${ask.caller} exits.` },
    always: { label: "Always", detail: w ? `Kept for the widget ${w.name}${where}. ${settings}` : bySite ? `Kept for ${a.site}${where}. ${settings}` : `Kept for “${permissionOf(a.permission)?.title ?? a.permission}”${where}. ${settings}` },
  };
  const who = w ? { icon: w.icon, name: ask.caller, context: [`${w.name} ${w.version}`, workspace].filter(Boolean).join(" · ") } : { icon: ask.callerKind === "operator" ? "brain" : "terminal", name: ask.caller, context: workspace ?? undefined };
  return (
    <ApprovalSheet<ApprovalScope, string>
      open={open}
      who={who}
      title={a.title}
      why={ask.why !== ask.tool ? ask.why : undefined}
      exact={a.exact || undefined}
      scopes={a.scopes.map((value) => ({ value, ...scope[value] }))}
      allow={a.risky ? "Run" : "Allow"}
      danger={a.risky}
      position={{ index: 1, count }}
      onAnswer={(r) => void answerAsk(ask, r.allow, r.allow ? { scope: r.scope } : { reason: r.reason }).catch(() => {})}
    />
  );
}

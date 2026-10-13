// The approval sheet in the app (docs/55): the oldest tool call waiting for the person, from any
// workspace, opens at once over the window; "1 of 3" when more wait. Return allows once, Esc
// denies; Allow's menu answers for this session or always, where the call offers it (lib/asks.ts,
// the kit's ApprovalSheet).

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
  // Allow gives the first scope; its menu the longer ones, each with what it covers.
  const where = workspace ? ` in “${workspace}”` : "";
  const verb = a.risky ? "Run" : "Allow";
  const scope: Record<ApprovalScope, { label: string; detail?: string }> = {
    once: { label: `${verb} Once` },
    session: { label: `${verb} for This Session`, detail: a.risky ? `Until ${ask.caller} exits. Risky actions are never allowed for always.` : `Until ${ask.caller} exits.` },
    always: { label: bySite ? `Always Allow for ${a.site}${where}` : `Always Allow${where}`, detail: bySite ? "Change it in Settings → AI & Agents → Permissions." : `For “${permissionOf(a.permission)?.title ?? a.permission}”. Change it in Settings → AI & Agents → Permissions.` },
  };
  return (
    <ApprovalSheet<ApprovalScope, string>
      open={open}
      who={{ icon: ask.callerKind === "operator" ? "brain" : "terminal", name: ask.caller, context: workspace ?? undefined }}
      title={a.title}
      why={ask.why !== ask.tool ? ask.why : undefined}
      exact={a.exact || undefined}
      scopes={a.scopes.map((value) => ({ value, ...scope[value] }))}
      allow={verb}
      danger={a.risky}
      position={{ index: 1, count }}
      onAnswer={(r) => void answerAsk(ask, r.allow, r.allow ? { scope: r.scope } : { reason: r.reason }).catch(() => {})}
    />
  );
}

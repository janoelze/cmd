// The approval sheet in the app (docs/55): the oldest tool call waiting for the person, from any
// workspace, opens at once over the window; "1 of 3" when more wait. Return allows, Esc denies;
// how long a yes holds is the call's to offer (lib/asks.ts, the kit's ApprovalSheet).

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
  const label: Record<ApprovalScope, string> = { once: "Once", session: "This session", always: bySite ? `Always for ${a.site}` : workspace ? `Always in “${workspace}”` : "Always here" };
  return (
    <ApprovalSheet<ApprovalScope>
      open={open}
      who={{ icon: ask.callerKind === "operator" ? "brain" : "terminal", name: ask.caller, context: workspace ?? undefined }}
      title={a.title}
      why={ask.why !== ask.tool ? ask.why : undefined}
      exact={a.exact || undefined}
      scopes={a.scopes.map((value) => ({ value, label: label[value] }))}
      allow={a.risky ? "Run" : "Allow"}
      danger={a.risky}
      position={{ index: 1, count }}
      onAnswer={(r) => void answerAsk(ask, r.allow, r.allow ? { scope: r.scope } : { reason: r.reason }).catch(() => {})}
    />
  );
}

// Settings → Agents → Permissions, after the levels (docs/55): the approvals kept for always, by
// workspace, each removable (it asks again), and the calls said no to lately, each with "Allow
// from now on" (kept for its workspace). Looks again whenever the window gets focus.

import { useEffect, useState } from "react";
import { Button, FormRow, FormSection } from "@cmd/ui";
import type { DeniedCall, RememberedApproval, Workspace } from "@cmd/protocol";
import { cmd } from "../lib/bridge.ts";

const time = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function AgentPermissions() {
  const [kept, setKept] = useState<RememberedApproval[]>([]);
  const [denied, setDenied] = useState<DeniedCall[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const look = () => {
    void cmd.call("approvals.list", {}).then(setKept, () => {});
    void cmd.call("approvals.denied", { limit: 8 }).then(setDenied, () => {});
    void cmd.call("workspace.list", {}).then((ws: Workspace[]) => setNames(new Map(ws.map((w) => [w.id, w.name]))), () => {});
  };
  useEffect(() => {
    look();
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, []);
  const where = (id: string) => names.get(id) ?? "A closed workspace";

  return (
    <>
      <FormSection title="Always allowed">
        {kept.length === 0 && <FormRow title="Nothing yet" description="When you choose Always in an approval, it shows here." />}
        {kept.map((k) => (
          <FormRow key={`${k.workspaceId}:${k.key}`} title={k.label} description={`In “${where(k.workspaceId)}” since ${time(k.at)}`}>
            <Button onClick={() => void cmd.call("approvals.forget", { workspaceId: k.workspaceId, key: k.key }).then(look)}>Remove</Button>
          </FormRow>
        ))}
      </FormSection>
      {denied.length > 0 && (
        <FormSection title="Recently denied">
          {denied.map((d) => (
            <FormRow key={d.id} title={`${d.caller}: ${d.title}`} description={`${time(d.at)} in “${where(d.workspaceId)}”${d.reason ? `: ${d.reason}` : ""}`}>
              {d.permission && <Button onClick={() => void cmd.call("approvals.allow", { workspaceId: d.workspaceId, permission: d.permission!, site: d.site }).then(look)}>Allow from Now On</Button>}
            </FormRow>
          ))}
        </FormSection>
      )}
    </>
  );
}

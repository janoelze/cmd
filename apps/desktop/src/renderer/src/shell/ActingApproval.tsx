// A tool call waiting for the person, answered from the title bar of the window it would act on
// (docs/54): an agent's own prompt shows only what the agent chose to send, so cmd asks itself,
// showing exactly what would happen. Allow, Deny (and say why), or Always Allow that here.

import { useState, type RefObject } from "react";
import { ChatApproval, Popover } from "@cmd/ui";
import type { ToolActivity } from "@cmd/protocol";
import { answerCall } from "../lib/acting.ts";

export function ActingApproval({ call, anchor, open, onClose }: { call: ToolActivity; anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const approval = call.approval;
  if (!approval) return null;
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="end" width={380} label={`${call.caller} asks`}>
      <ChatApproval
        title={`${call.caller}: ${approval.title}`}
        exact={approval.exact}
        always={approval.offer}
        busy={busy}
        onAnswer={(allow, reason, remember) => {
          setBusy(true);
          void answerCall(call, allow, reason, remember).finally(() => (setBusy(false), onClose()));
        }}
      />
    </Popover>
  );
}

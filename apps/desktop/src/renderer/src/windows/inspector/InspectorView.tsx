// An Inspector window (docs/59): a browser window's DevTools in a window of their own, beside the
// page on the board. Its browser window closing closes it (core windows/ops.ts); one restored
// without its page says so.

import { Button, View } from "@cmd/ui";
import { cmd } from "../../lib/bridge.ts";
import { useStoreValue } from "../../lib/store.ts";
import { stateStr, type WindowViewProps } from "../registry.ts";
import { InspectorFrame } from "./InspectorFrame.tsx";

export function InspectorView({ win }: WindowViewProps) {
  const forId = stateStr(win, "for");
  const page = useStoreValue((s) => (forId ? s.windows.get(forId) : undefined));
  const close = <Button onClick={() => void cmd.call("window.close", { id: win.id }).catch(() => {})}>Close</Button>;
  const state =
    !forId || page?.kind !== "browser"
      ? { kind: "empty" as const, icon: "chevron.left.forwardslash.chevron.right", title: "Page Closed", text: "The browser window this inspected is closed.", action: close }
      : null;
  return (
    <View scroll={false} state={state}>
      {!state && forId && <InspectorFrame forId={forId} />}
    </View>
  );
}

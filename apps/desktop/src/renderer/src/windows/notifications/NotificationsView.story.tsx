// The Notifications widget on a real log, the Workbench instance's own (read by the real core,
// as the SQLite window's story reads its database): one workspace's ("ws-1", the widget
// fixtures' workspace), every workspace's, one with none, and every size. Its package,
// Notification Log (packages/widgets/notifications), has stories from fixtures; to compare the
// two on the same notifications, import those into the Workbench's log first (`data.import`).

import type { AppWindow, WindowId, WorkspaceId } from "@cmd/protocol";
import { AllSizes, RefWindow, type SizeName } from "../../reference/RefWindow.tsx";
import { NotificationsView } from "./NotificationsView.tsx";

function W({ size = "regular", workspaceId = "ws-1", scope }: { size?: SizeName; workspaceId?: string; scope?: "all" }) {
  const win = { id: "story-notifications" as WindowId, kind: "notifications", workspaceId: workspaceId as WorkspaceId, title: "Notifications", createdAt: 0, updatedAt: 0, state: scope ? { scope } : {} } as AppWindow;
  return (
    <RefWindow icon="bell" name="Notifications" size={size}>
      <NotificationsView win={win} focused={false} />
    </RefWindow>
  );
}

export const ThisWorkspace = () => <W />;
export const AllWorkspaces = () => <W scope="all" />;
export const Empty = () => <W workspaceId="ws-none" />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;

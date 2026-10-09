// Workbench stories (pnpm workbench youtubeview): the YouTube widget before it has a
// video (paste a link), at every size. The player is a webview on a Stage.

import type { AppWindow, WindowId, WorkspaceId } from "@cmd/protocol";
import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { YouTubeView } from "./YouTubeView.tsx";

const win = { id: "story-yt" as WindowId, kind: "youtube", workspaceId: "story" as WorkspaceId, state: {} } as unknown as AppWindow;

function W({ size = "regular" }: { size?: SizeName }) {
  return (
    <RefWindow icon="play.rectangle" name="YouTube" size={size}>
      <YouTubeView win={win} focused={false} />
    </RefWindow>
  );
}

export const Ask = () => <W />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;

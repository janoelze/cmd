// The Event Stream on a real log, the Workbench instance's own (read by the real core, as the
// SQLite window's story reads its database), with the window's state kept here: the log, two
// classes hidden, paused, and every size. Its package, Event Log (packages/widgets/events), has
// stories from fixtures; to compare the two on the same events, import those into the
// Workbench's log first (`data.import`).

import type { AppWindow, WindowId, WorkspaceId } from "@cmd/protocol";
import { AllSizes, RefWindow, type SizeName } from "../../reference/RefWindow.tsx";
import { EventsView } from "./EventsView.tsx";

function W({ size = "regular", state = {} }: { size?: SizeName; state?: Record<string, unknown> }) {
  const win = { id: "story-events" as WindowId, kind: "events", workspaceId: "story" as WorkspaceId, title: "Event Stream", createdAt: 0, updatedAt: 0, state } as AppWindow;
  return (
    <RefWindow icon="waveform.path.ecg" name="Event Stream" size={size}>
      <EventsView win={win} focused={false} />
    </RefWindow>
  );
}

export const Log = () => <W />;
export const Hidden = () => <W state={{ hidden: ["output", "git"] }} />;
export const Paused = () => <W state={{ paused: true }} />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;

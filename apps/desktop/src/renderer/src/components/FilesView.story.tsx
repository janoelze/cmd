// Workbench stories (pnpm workbench filesview): the Files window on this checkout,
// through the Workbench's real core: a window at every size, the sidebar's dense
// version, a folder that can't be read.

import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { storyWindow, useRepoFile } from "../reference/RepoFile.tsx";
import { PlacementContext } from "../windows/registry.ts";
import { FilesView } from "./FilesView.tsx";

function W({ rel = "packages/ui", size = "regular" }: { rel?: string; size?: SizeName | readonly [number, number] }) {
  const path = useRepoFile(rel);
  return (
    <RefWindow icon="folder" name="Files" size={size}>
      {path && <FilesView key={path} win={storyWindow("files", { path })} focused={false} />}
    </RefWindow>
  );
}

export const Default = () => <W />;
export const Sidebar = () => (
  <PlacementContext.Provider value="sidebar">
    <W size={[260, 520]} />
  </PlacementContext.Provider>
);
export const Unreadable = () => <W rel="no-such-folder" />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;

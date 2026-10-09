// Workbench stories (pnpm workbench livediff): the Live Diff widget with stand-in
// changes: files open and closed, a new file, a binary, a staged rename; nothing
// uncommitted; not a repository; loading; every size.

import { useState } from "react";
import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { LiveDiffView, type DiffFile } from "./LiveDiff.tsx";

const DIR = "/Users/jan/src/cmd";
const FILES: DiffFile[] = [
  { abs: `${DIR}/apps/desktop/src/renderer/src/components/LiveDiff.tsx`, rel: "apps/desktop/src/renderer/src/components/LiveDiff.tsx", state: "modified", staged: false, added: 3, removed: 2, open: true, lines: ["@@ -4,7 +4,7 @@ // Live Diff, a built-in widget", " // checkout), and by polling while cmd is in front.", "-import { Badge, Button, EmptyState } from \"@cmd/ui\";", "-import \"./widgets.css\";", "+import { Badge, Button, Diff, List, ListRow } from \"@cmd/ui\";", "+import { Text, Twisty, View } from \"@cmd/ui\";", "+// the drawing is LiveDiffView", " import { useCallback } from \"react\";"] },
  { abs: `${DIR}/packages/ui/src/layout.tsx`, rel: "packages/ui/src/layout.tsx", state: "modified", staged: true, added: 18, removed: 0, open: false },
  { abs: `${DIR}/apps/desktop/src/renderer/src/components/LiveDiff.story.tsx`, rel: "apps/desktop/src/renderer/src/components/LiveDiff.story.tsx", state: "untracked", staged: false, added: 2, removed: 0, open: true, lines: ["@@ -0,0 +1,2 @@", "+// Workbench stories (pnpm workbench livediff)", "+import { useState } from \"react\";"] },
  { abs: `${DIR}/website/og.png`, rel: "website/og.png", state: "modified", staged: false, added: 0, removed: 0, open: true, note: "Binary file" },
  { abs: `${DIR}/docs/41-widgets.md`, rel: "docs/41-widgets.md", state: "renamed", staged: true, added: 0, removed: 0, open: false },
  { abs: `${DIR}/apps/desktop/src/renderer/src/components/widgets.css`, rel: "apps/desktop/src/renderer/src/components/widgets.css", state: "deleted", staged: false, added: 0, removed: 22, open: false },
];

function W({ size = "regular", files = FILES, state = "ok" as const }: { size?: SizeName; files?: DiffFile[]; state?: "loading" | "noRepo" | "ok" }) {
  const [list, setList] = useState(files);
  return (
    <RefWindow icon="plusminus" name="Changes · cmd" size={size}>
      <LiveDiffView state={state} dir={DIR} files={list} truncated={false} onToggle={(rel, open) => setList((l) => l.map((f) => (f.rel === rel ? { ...f, open } : f)))} onOpen={() => {}} onChoose={() => {}} />
    </RefWindow>
  );
}

export const Default = () => <W />;
export const Clean = () => <W files={[]} />;
export const NotARepository = () => <W state="noRepo" />;
export const Loading = () => <W state="loading" />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;

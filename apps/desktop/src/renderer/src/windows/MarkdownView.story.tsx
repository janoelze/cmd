// Workbench stories (pnpm workbench markdownview): the Markdown window on real
// files, read by the real core: the README (headings, tables, code), a long doc,
// a file that isn't there, and every size.

import type { AppWindow, WindowId, WorkspaceId } from "@cmd/protocol";
import { useEffect, useState } from "react";
import { cmd } from "../bridge.ts";
import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { MarkdownView } from "./markdown-view.tsx";

/** A file in the checkout the core runs from. */
function useRepoFile(rel: string): string | null {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => void cmd.call("core.hello", {}).then((h) => h.root && setPath(`${h.root}/${rel}`), () => {}), [rel]);
  return path;
}

function Md({ rel, size = "wide" }: { rel: string; size?: SizeName }) {
  const path = useRepoFile(rel);
  const win = { id: `story-md-${rel}` as WindowId, kind: "markdown", workspaceId: "story" as WorkspaceId, state: { path } } as unknown as AppWindow;
  return (
    <RefWindow icon="doc.richtext" name={rel.split("/").pop()!} size={size}>
      {path && <MarkdownView win={win} focused={false} />}
    </RefWindow>
  );
}

export const Readme = () => <Md rel="README.md" />;
export const Doc = () => <Md rel="docs/40-window-design.md" />;
export const Missing = () => <Md rel="docs/not-there.md" />;
export const Sizes = () => <AllSizes render={(s) => <Md rel="README.md" size={s} />} />;

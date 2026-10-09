// For stories of windows that open a file: a path in the checkout the Workbench's
// core runs from (core.hello's root), so the real core reads a real file.

import type { AppWindow, WindowId, WorkspaceId } from "@cmd/protocol";
import { useEffect, useState } from "react";
import { cmd } from "../bridge.ts";

export function useRepoFile(rel: string): string | null {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => void cmd.call("core.hello", {}).then((h) => h.root && setPath(`${h.root}/${rel}`), () => {}), [rel]);
  return path;
}

/** A stand-in window of a kind, with this state. */
export const storyWindow = (kind: string, state: Record<string, unknown>): AppWindow => ({ id: `story-${kind}` as WindowId, kind, workspaceId: "story" as WorkspaceId, state }) as unknown as AppWindow;

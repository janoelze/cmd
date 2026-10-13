// Workspace: switching (the switcher's order, wrapping around; Last Workspace is the one shown
// before), moving a window to another, renaming, its icon and folder, closing.

import type { WorkspaceId } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { getState, onState } from "../../lib/store.ts";
import { openSheet } from "../sheets.ts";
import { closeWorkspace, showWorkspace } from "../workspaces.tsx";
import { registerCommands, type Command } from "./registry.ts";

let shown: WorkspaceId = getState().workspaceId;
let last: WorkspaceId | null = null;
onState(() => {
  const now = getState().workspaceId;
  if (now !== shown) (last = shown), (shown = now);
});

const step = (d: number): Command => ({
  when: (c) => c.workspaces.length > 1,
  run: (c) => {
    const i = c.workspaces.findIndex((x) => x.id === c.state.workspaceId);
    const next = c.workspaces[(i + d + c.workspaces.length) % c.workspaces.length];
    if (next && next.id !== c.state.workspaceId) showWorkspace(next.id);
  },
});

/** ⌃1–⌃9 like Arc's spaces. */
const nth = (n: number): Command => ({ run: (c) => c.workspaces[n - 1] && showWorkspace(c.workspaces[n - 1]!.id) });

registerCommands({
  "workspace.next": step(1),
  "workspace.prev": step(-1),
  "workspace.last": { run: (c) => last && c.state.workspaces.has(last) && showWorkspace(last) },
  "workspace.moveWindow": { when: (c) => !!c.selected && c.workspaces.length > 1, run: (c) => openSheet({ kind: "picker", picker: { kind: "move", windowId: c.selected! } }) },
  "workspace.rename": { when: (c) => !!c.workspace, run: (c) => openSheet({ kind: "picker", picker: { kind: "rename", workspace: c.workspace! } }) },
  "workspace.icon": { when: (c) => !!c.workspace, run: (c) => openSheet({ kind: "picker", picker: { kind: "icon", workspace: c.workspace! } }) },
  "workspace.reveal": { when: (c) => !!c.workspace, run: (c) => cmd.openPath(c.workspace!.root, { from: "user" }) },
  "workspace.close": { when: (c) => !!c.workspace && !c.workspace.home, run: (c) => void closeWorkspace(c.workspace!).catch(() => {}) },
  "workspace.select1": nth(1),
  "workspace.select2": nth(2),
  "workspace.select3": nth(3),
  "workspace.select4": nth(4),
  "workspace.select5": nth(5),
  "workspace.select6": nth(6),
  "workspace.select7": nth(7),
  "workspace.select8": nth(8),
  "workspace.select9": nth(9),
});

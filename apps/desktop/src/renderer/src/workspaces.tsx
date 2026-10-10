// Workspace actions and pickers (docs/11-workspaces.md). Showing a workspace always goes
// through main (main/workspaces.ts), which knows which app window shows what. The
// pickers reuse the command palette: ⌘O opens or switches workspaces, plus "Move
// to Workspace" and "Rename Workspace".

import { useEffect, useState, type ComponentProps } from "react";
import type { Agent, Workspace, WorkspaceId } from "@cmd/protocol";
import { agentName } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { byActivity, byProject, shortPath, workspaceDetail } from "./model.ts";
import { getState, useStoreValue } from "./store.ts";
import type { Palette, PaletteItem } from "./components/Palette.tsx";

/** workspace: ⌘O; with newWindow (New Window…), ↵ opens the workspace in a window of its own. */
export type Picker = { kind: "new" } | { kind: "workspace"; newWindow?: boolean } | { kind: "move"; windowId: string } | { kind: "rename"; workspace: Workspace } | { kind: "renameAgent"; agent: Agent } | { kind: "icon"; workspace: Workspace };

/** Show a workspace here, or in the window that already shows it (newWindow: in a new one). */
export function showWorkspace(id: WorkspaceId, o: { select?: string; newWindow?: boolean } = {}): void {
  cmd.showWorkspace(id, o);
}

/** Open a folder as a workspace (attach-or-create in the core) without showing it. */
async function openFolder(path: string): Promise<Workspace | null> {
  try {
    return (await cmd.call("workspace.open", { path })).workspace;
  } catch (err) {
    await cmd.confirm({ message: "Can't open that as a workspace", detail: (err as Error).message, confirm: "OK" });
    return null;
  }
}

export async function openWorkspace(path: string, newWindow = false): Promise<void> {
  const workspace = await openFolder(path);
  if (workspace) showWorkspace(workspace.id, { newWindow });
}

async function browse(newWindow = false): Promise<void> {
  const dir = await cmd.chooseFolder();
  if (dir) await openWorkspace(dir, newWindow);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Close a workspace: its terminals end and its windows go; it stays in ⌘O's Recent. */
export async function closeWorkspace(workspace: Workspace): Promise<void> {
  if (workspace.home) return;
  const s = getState();
  const panes = [...s.panes.values()].filter((p) => p.workspaceId === workspace.id);
  const agents = [...s.agents.values()].filter((a) => a.workspaceId === workspace.id && a.paneId);
  const windows = [...s.windows.values()].filter((w) => w.workspaceId === workspace.id);
  if (panes.length || windows.length) {
    const what = [panes.length && plural(panes.length, "terminal"), windows.length && plural(windows.length, "window")].filter(Boolean).join(" and ");
    const ok = await cmd.confirm({
      message: `Close the workspace “${workspace.name}”?`,
      detail:
        `Its ${what} will be closed.` +
        (agents.length ? ` ${plural(agents.length, "agent")} will end; Claude and Codex sessions can be resumed.` : "") +
        ` Open Workspace (⌘O) brings the workspace back later.`,
      confirm: "Close Workspace",
    });
    if (!ok) return;
  }
  await cmd.call("workspace.close", { id: workspace.id });
}

/** Palette input that names a folder: absolute, ~ or relative (to the home folder). */
const looksLikePath = (q: string) => /^(~|\/|\.{1,2}(\/|$))/.test(q.trim());

type PaletteProps = ComponentProps<typeof Palette>;

/** Palette props for the open picker, or null. */
export function usePickers(picker: Picker | null, close: () => void): PaletteProps | null {
  const workspaces = useStoreValue((s) => s.workspaces);
  const here = useStoreValue((s) => s.workspaceId);
  const [recent, setRecent] = useState<Workspace[]>([]);
  const [folders, setFolders] = useState<string[]>([]);

  // Closed workspaces and the folders of recent agent sessions, fetched when a picker opens.
  const kind = picker?.kind;
  useEffect(() => {
    if (kind !== "workspace" && kind !== "move") return;
    let live = true;
    // A closed workspace whose folder is gone has nothing left to open.
    void cmd.call("workspace.list", { closed: true }).then((l) => live && setRecent(l.filter((x) => x.closedAt !== null && !x.gone)), () => {});
    void cmd.call("data.view", { query: { view: "sessions", limit: 50 } }).then(
      (rows) => live && setFolders([...new Set(rows.map((r) => r.cwd).filter((c): c is string => !!c))]),
      () => {},
    );
    return () => void (live = false);
  }, [kind]);

  if (!picker || picker.kind === "icon" || picker.kind === "new") return null; // their own: WorkspaceIconPicker, NewPicker
  // Most recently active first (agents that just finished, the workspace you just left).
  const open = byActivity({ ...getState(), workspaces }, here);
  const known = new Set([...open, ...recent].map((x) => x.root));
  const typed = (q: string, label: (p: string) => string, run: (p: string) => void): PaletteItem[] =>
    looksLikePath(q) ? [{ id: "typed-path", group: "Folders", label: label(q.trim()), run: () => run(q.trim()) }] : [];

  if (picker.kind === "rename") {
    const sp = picker.workspace;
    return {
      items: [],
      onClose: close,
      initialQuery: sp.name,
      placeholder: `Name for ${shortPath(sp.root)}`,
      emptyText: "Type a new name",
      footer: <span><kbd>↵</kbd> rename</span>,
      dynamic: (q) => {
        const name = q.trim();
        if (!name || name === sp.name) return [];
        return [{ id: "rename", group: "Workspaces", label: `Rename to “${name}”`, run: () => void cmd.call("workspace.update", { id: sp.id, name }) }];
      },
    };
  }

  if (picker.kind === "renameAgent") {
    const a = getState().agents.get(picker.agent.id) ?? picker.agent;
    const mine = a.nameBy === "user";
    return {
      items: [],
      onClose: close,
      initialQuery: a.name ?? "",
      placeholder: `Name for ${agentName(a)}`,
      emptyText: mine ? "Type a new name" : "Type a name",
      footer: <span><kbd>↵</kbd> rename</span>,
      dynamic: (q) => {
        const name = q.trim().replace(/\s+/g, " ");
        if (!name) return mine ? [{ id: "auto", group: "Agents", label: "Let cmd name it", run: () => void cmd.call("agent.rename", { agentId: a.id, name: null }) }] : [];
        if (name === a.name && mine) return [];
        return [{ id: "rename", group: "Agents", label: `Rename to “${name}”`, run: () => void cmd.call("agent.rename", { agentId: a.id, name }) }];
      },
    };
  }

  if (picker.kind === "move") {
    const from = getState().panes.get(picker.windowId)?.workspaceId ?? getState().windows.get(picker.windowId)?.workspaceId;
    const move = (workspaceId: WorkspaceId) => void cmd.call("window.move", { id: picker.windowId, workspaceId });
    const moveToFolder = async (path: string) => {
      const sp = await openFolder(path);
      if (sp) move(sp.id);
    };
    return {
      items: [
        ...open.filter((sp) => sp.id !== from).map((sp) => ({ id: `sp-${sp.id}`, group: "Workspaces" as const, label: sp.name, meta: workspaceDetail(sp), run: () => move(sp.id) })),
        ...byProject(recent).map((sp) => ({ id: `re-${sp.id}`, group: "Recent" as const, label: sp.name, meta: workspaceDetail(sp), run: () => void moveToFolder(sp.root) })),
      ],
      onClose: close,
      placeholder: "Move the window to a workspace, or type a folder",
      emptyText: "No other workspace. Type a folder to open one.",
      footer: <span><kbd>↵</kbd> move</span>,
      dynamic: (q) => typed(q, (p) => `Move to a workspace at ${p}`, (p) => void moveToFolder(p)),
    };
  }

  // New Window…: ↵ does what ⌘↵ does in ⌘O; the workspace shown here has its window already.
  const apart = !!picker.newWindow;
  const items: PaletteItem[] = [
    ...open
      .filter((sp) => !apart || sp.id !== here)
      .map((sp) => ({
        id: `sp-${sp.id}`,
        group: "Workspaces" as const,
        label: sp.id === here ? `${sp.name} (shown)` : sp.name,
        meta: workspaceDetail(sp),
        run: () => showWorkspace(sp.id, { newWindow: apart }),
        runAlt: () => showWorkspace(sp.id, { newWindow: true }),
      })),
    ...byProject(recent).map((sp) => ({
      id: `re-${sp.id}`,
      group: "Recent" as const,
      label: sp.name,
      meta: workspaceDetail(sp),
      run: () => void openWorkspace(sp.root, apart),
      runAlt: () => void openWorkspace(sp.root, true),
    })),
    ...folders
      .filter((f) => !known.has(f))
      .map((f) => ({
        id: `f-${f}`,
        group: "Folders" as const,
        label: f.split(/[\\/]/).filter(Boolean).pop() ?? f,
        meta: `${shortPath(f)} · recent session`,
        run: () => void openWorkspace(f, apart),
        runAlt: () => void openWorkspace(f, true),
      })),
    { id: "browse", group: "Commands", label: "Browse for a Folder…", run: () => void browse(apart), runAlt: () => void browse(true) },
  ];
  return {
    items,
    onClose: close,
    placeholder: apart ? "Open a workspace in a new window, or type a folder" : "Switch to a workspace, or open a folder (~/src/…)",
    emptyText: "Nothing matches. Type a path to open a folder.",
    footer: apart ? (
      <>
        <span><kbd>↵</kbd> open in a new window</span>
        <span>type a path to open a folder</span>
      </>
    ) : (
      <>
        <span><kbd>↵</kbd> show</span>
        <span><kbd>⌘↵</kbd> in a new window</span>
        <span>type a path to open a folder</span>
      </>
    ),
    dynamic: (q) =>
      looksLikePath(q)
        ? [{ id: "typed-path", group: "Folders", label: `Open ${q.trim()}`, run: () => void openWorkspace(q.trim(), apart), runAlt: () => void openWorkspace(q.trim(), true) }]
        : [],
  };
}

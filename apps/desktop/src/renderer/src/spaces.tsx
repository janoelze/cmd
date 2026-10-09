// Space actions and pickers (docs/11-spaces.md). Showing a Space always goes
// through main (main/spaces.ts), which knows which app window shows what. The
// pickers reuse the command palette: ⌘O opens or switches Spaces, plus "Move
// to Space" and "Rename Space".

import { useEffect, useState, type ComponentProps } from "react";
import type { Agent, Space, SpaceId } from "@cmd/protocol";
import { agentName } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { byProject, shortPath, spaceDetail } from "./model.ts";
import { getState, useStoreValue } from "./store.ts";
import type { Palette, PaletteItem } from "./components/Palette.tsx";

/** space: ⌘O; with newWindow (New Window…), ↵ opens the Space in a window of its own. */
export type Picker = { kind: "new" } | { kind: "space"; newWindow?: boolean } | { kind: "move"; windowId: string } | { kind: "rename"; space: Space } | { kind: "renameAgent"; agent: Agent } | { kind: "icon"; space: Space };

/** Show a Space here, or in the window that already shows it (newWindow: in a new one). */
export function showSpace(id: SpaceId, o: { select?: string; newWindow?: boolean } = {}): void {
  cmd.showSpace(id, o);
}

/** Open a folder as a Space (attach-or-create in the core) without showing it. */
async function openFolder(path: string): Promise<Space | null> {
  try {
    return (await cmd.call("space.open", { path })).space;
  } catch (err) {
    await cmd.confirm({ message: "Can't open that as a Space", detail: (err as Error).message, confirm: "OK" });
    return null;
  }
}

export async function openSpace(path: string, newWindow = false): Promise<void> {
  const space = await openFolder(path);
  if (space) showSpace(space.id, { newWindow });
}

async function browse(newWindow = false): Promise<void> {
  const dir = await cmd.chooseFolder();
  if (dir) await openSpace(dir, newWindow);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Close a Space: its terminals end and its windows go; it stays in ⌘O's Recent. */
export async function closeSpace(space: Space): Promise<void> {
  if (space.home) return;
  const s = getState();
  const panes = [...s.panes.values()].filter((p) => p.spaceId === space.id);
  const agents = [...s.agents.values()].filter((a) => a.spaceId === space.id && a.paneId);
  const windows = [...s.windows.values()].filter((w) => w.spaceId === space.id);
  if (panes.length || windows.length) {
    const what = [panes.length && plural(panes.length, "terminal"), windows.length && plural(windows.length, "window")].filter(Boolean).join(" and ");
    const ok = await cmd.confirm({
      message: `Close the Space “${space.name}”?`,
      detail:
        `Its ${what} will be closed.` +
        (agents.length ? ` ${plural(agents.length, "agent")} will end; Claude and Codex sessions can be resumed.` : "") +
        ` Open Space (⌘O) brings the Space back later.`,
      confirm: "Close Space",
    });
    if (!ok) return;
  }
  await cmd.call("space.close", { id: space.id });
}

/** Palette input that names a folder: absolute, ~ or relative (to the home folder). */
const looksLikePath = (q: string) => /^(~|\/|\.{1,2}(\/|$))/.test(q.trim());

type PaletteProps = ComponentProps<typeof Palette>;

/** Palette props for the open picker, or null. */
export function usePickers(picker: Picker | null, close: () => void): PaletteProps | null {
  const spaces = useStoreValue((s) => s.spaces);
  const here = useStoreValue((s) => s.spaceId);
  const [recent, setRecent] = useState<Space[]>([]);
  const [folders, setFolders] = useState<string[]>([]);

  // Closed Spaces and the folders of recent agent sessions, fetched when a picker opens.
  const kind = picker?.kind;
  useEffect(() => {
    if (kind !== "space" && kind !== "move") return;
    let live = true;
    // A closed Space whose folder is gone has nothing left to open.
    void cmd.call("space.list", { closed: true }).then((l) => live && setRecent(l.filter((x) => x.closedAt !== null && !x.gone)), () => {});
    void cmd.call("data.view", { query: { view: "sessions", limit: 50 } }).then(
      (rows) => live && setFolders([...new Set(rows.map((r) => r.cwd).filter((c): c is string => !!c))]),
      () => {},
    );
    return () => void (live = false);
  }, [kind]);

  if (!picker || picker.kind === "icon" || picker.kind === "new") return null; // their own: SpaceIconPicker, NewPicker
  const open = byProject([...spaces.values()].sort((a, b) => a.order - b.order));
  const known = new Set([...open, ...recent].map((x) => x.root));
  const typed = (q: string, label: (p: string) => string, run: (p: string) => void): PaletteItem[] =>
    looksLikePath(q) ? [{ id: "typed-path", group: "Folders", label: label(q.trim()), run: () => run(q.trim()) }] : [];

  if (picker.kind === "rename") {
    const sp = picker.space;
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
        return [{ id: "rename", group: "Spaces", label: `Rename to “${name}”`, run: () => void cmd.call("space.update", { id: sp.id, name }) }];
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
    const from = getState().panes.get(picker.windowId)?.spaceId ?? getState().windows.get(picker.windowId)?.spaceId;
    const move = (spaceId: SpaceId) => void cmd.call("window.move", { id: picker.windowId, spaceId });
    const moveToFolder = async (path: string) => {
      const sp = await openFolder(path);
      if (sp) move(sp.id);
    };
    return {
      items: [
        ...open.filter((sp) => sp.id !== from).map((sp) => ({ id: `sp-${sp.id}`, group: "Spaces" as const, label: sp.name, meta: spaceDetail(sp), run: () => move(sp.id) })),
        ...byProject(recent).map((sp) => ({ id: `re-${sp.id}`, group: "Recent" as const, label: sp.name, meta: spaceDetail(sp), run: () => void moveToFolder(sp.root) })),
      ],
      onClose: close,
      placeholder: "Move the window to a Space, or type a folder",
      emptyText: "No other Space. Type a folder to open one.",
      footer: <span><kbd>↵</kbd> move</span>,
      dynamic: (q) => typed(q, (p) => `Move to a Space at ${p}`, (p) => void moveToFolder(p)),
    };
  }

  // New Window…: ↵ does what ⌘↵ does in ⌘O; the Space shown here has its window already.
  const apart = !!picker.newWindow;
  const items: PaletteItem[] = [
    ...open
      .filter((sp) => !apart || sp.id !== here)
      .map((sp) => ({
        id: `sp-${sp.id}`,
        group: "Spaces" as const,
        label: sp.id === here ? `${sp.name} (shown)` : sp.name,
        meta: spaceDetail(sp),
        run: () => showSpace(sp.id, { newWindow: apart }),
        runAlt: () => showSpace(sp.id, { newWindow: true }),
      })),
    ...byProject(recent).map((sp) => ({
      id: `re-${sp.id}`,
      group: "Recent" as const,
      label: sp.name,
      meta: spaceDetail(sp),
      run: () => void openSpace(sp.root, apart),
      runAlt: () => void openSpace(sp.root, true),
    })),
    ...folders
      .filter((f) => !known.has(f))
      .map((f) => ({
        id: `f-${f}`,
        group: "Folders" as const,
        label: f.split(/[\\/]/).filter(Boolean).pop() ?? f,
        meta: `${shortPath(f)} · recent session`,
        run: () => void openSpace(f, apart),
        runAlt: () => void openSpace(f, true),
      })),
    { id: "browse", group: "Commands", label: "Browse for a Folder…", run: () => void browse(apart), runAlt: () => void browse(true) },
  ];
  return {
    items,
    onClose: close,
    placeholder: apart ? "Open a Space in a new window, or type a folder" : "Switch to a Space, or open a folder (~/src/…)",
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
        ? [{ id: "typed-path", group: "Folders", label: `Open ${q.trim()}`, run: () => void openSpace(q.trim(), apart), runAlt: () => void openSpace(q.trim(), true) }]
        : [],
  };
}

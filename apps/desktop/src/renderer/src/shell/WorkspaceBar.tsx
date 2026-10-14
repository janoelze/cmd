// The workspace switcher in the top bar (docs/11-workspaces.md, 21-sidebars.md): a button
// with the shown workspace's icon and name that drops down a menu of the open workspaces in
// the switcher's order (⌃1–9; rows never move, a dot says where something happened), one line
// each: icon, name, folder, and a dot when something in it needs you or finished unseen.
// Then the three most recently closed (Recent) and Open Workspace… (⌘O). The
// button carries the same mark for the other workspaces, so a background workspace that
// wants you shows without opening the menu.

import { useRef, useState } from "react";
import { useWholePixelWidth } from "../lib/pixels.ts";
import { Badge, Menu, StatusDot, type MenuItemProps } from "@cmd/ui";
import type { Workspace, WorkspaceId } from "@cmd/protocol";
import { ICON, Symbol } from "../components/Symbol.tsx";
import { WorkspaceIcon } from "./WorkspaceIcon.tsx";
import { workspaceDetail } from "../lib/model.ts";
import { openWorkspace, recentLabels, useRecentWorkspaces } from "./workspaces.tsx";

type Attention = "needs" | "unseen";

interface Props {
  workspaces: Workspace[];
  current: WorkspaceId;
  attention: Map<WorkspaceId, Attention>;
  onShow: (id: WorkspaceId, opts?: { newWindow?: boolean }) => void;
  onMenu: (workspace: Workspace) => void;
  /** "Open Workspace…" at the end of the menu: the workspace picker (⌘O). */
  onPicker: () => void;
}

export function WorkspaceBar(p: Props) {
  const [open, setOpen] = useState(false);
  const recent = recentLabels(useRecentWorkspaces(), 3);
  const button = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLSpanElement>(null);
  useWholePixelWidth(name); // the badge and chevron after it stay crisp
  const shown = p.workspaces.find((sp) => sp.id === p.current);
  // The strongest mark among the other workspaces, and how many have one.
  const others = p.workspaces.filter((sp) => sp.id !== p.current && p.attention.has(sp.id));
  const mark: Attention | undefined = others.some((sp) => p.attention.get(sp.id) === "needs") ? "needs" : others.length ? "unseen" : undefined;
  const items: MenuItemProps[] = p.workspaces.map((sp, i) => {
    const on = sp.id === p.current;
    const attn = on ? undefined : p.attention.get(sp.id);
    return {
      label: sp.name,
      text: sp.name,
      // Marked left-to-right: the folder is clipped at its start (styles.css), keeping its end.
      detail: `\u200e${workspaceDetail(sp)}\u200e`,
      icon: <WorkspaceIcon workspace={sp} />,
      accessory: attn && <StatusDot state={attn} size="sm" label={attn === "needs" ? "Needs you" : "Done"} />,
      checked: on,
      shortcut: i < 9 ? `⌃${i + 1}` : undefined,
      className: "workspace-item",
      // ⌘-click: the workspace in a new window.
      onSelect: ({ metaKey }) => (sp.id !== p.current || metaKey) && p.onShow(sp.id, metaKey ? { newWindow: true } : undefined),
      onContextMenu: () => p.onMenu(sp),
    };
  });
  // Recent: ↵ reopens the closed workspace here, ⌘↵ in a new window.
  const recentItems: MenuItemProps[] = recent.map(({ workspace: sp, label }) => ({
    label,
    text: label,
    detail: `\u200e${workspaceDetail(sp)}\u200e`,
    icon: <WorkspaceIcon workspace={sp} />,
    className: "workspace-recent",
    onSelect: ({ metaKey }) => void openWorkspace(sp.root, metaKey),
  }));
  // No workspaces yet: the core hasn't sent its first snapshot (there's always Home
  // after it), so there is nothing to pick and the picker couldn't open one.
  if (!p.workspaces.length)
    return (
      <div className="workspace-bar">
        <span className="workspace-trigger pending">Connecting…</span>
      </div>
    );
  return (
    <div className="workspace-bar">
      <button
        ref={button}
        className={`workspace-trigger ${open ? "open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={shown ? workspaceDetail(shown) : undefined}
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => (e.preventDefault(), setOpen(false), shown && p.onMenu(shown))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") e.preventDefault(), setOpen(true);
        }}
      >
        {shown && <WorkspaceIcon workspace={shown} />}
        <span ref={name} className="workspace-name">{shown?.name ?? "Workspaces"}</span>
        {mark && (
          <Badge size="sm" solid tone={mark === "needs" ? "warning" : "success"} tip={`${others.length} other workspace${others.length === 1 ? "" : "s"} ${mark === "needs" ? "need you" : "finished"}`}>
            {others.length}
          </Badge>
        )}
        <Symbol name="chevron.down" size={ICON.disclosure} />
      </button>
      <Menu
        anchor={button}
        open={open}
        onClose={() => setOpen(false)}
        label="Workspaces"
        className="workspace-menu"
        placement="below"
        align="center"
        marks="row"
        inline
        width="content"
        maxWidth={400}
        items={[
          ...items,
          ...(recentItems.length ? [null, "Recent", ...recentItems] : []),
          null,
          { label: "Open Workspace…", icon: "plus", shortcut: "⌘O", className: "workspace-item workspace-item-open", onSelect: p.onPicker },
        ]}
      />
    </div>
  );
}

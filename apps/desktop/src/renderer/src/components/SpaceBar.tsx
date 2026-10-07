// The Space switcher in the top bar (docs/11-spaces.md, 21-sidebars.md): a button
// with the shown Space's icon and name that drops down a menu of the open Spaces
// in switcher order (⌃1–9), one line each: icon, name, folder, and a dot when
// something in it needs you or finished unseen. The button carries the same mark
// for the other Spaces, so a background Space that wants you shows without
// opening the menu.

import { useRef, useState } from "react";
import { useWholePixelWidth } from "../pixels.ts";
import { Badge, Menu, StatusDot, type MenuItemProps } from "@cmd/ui";
import type { Space, SpaceId } from "@cmd/protocol";
import { shortPath } from "../model.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { SpaceIcon } from "./SpaceIcon.tsx";

type Attention = "needs" | "unseen";

interface Props {
  spaces: Space[];
  current: SpaceId;
  attention: Map<SpaceId, Attention>;
  onShow: (id: SpaceId, opts?: { newWindow?: boolean }) => void;
  onMenu: (space: Space) => void;
  /** "Open Space…" at the end of the menu: the Space picker (⌘O). */
  onPicker: () => void;
}

export function SpaceBar(p: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLSpanElement>(null);
  useWholePixelWidth(name); // the badge and chevron after it stay crisp
  const shown = p.spaces.find((sp) => sp.id === p.current);
  // The strongest mark among the other Spaces, and how many have one.
  const others = p.spaces.filter((sp) => sp.id !== p.current && p.attention.has(sp.id));
  const mark: Attention | undefined = others.some((sp) => p.attention.get(sp.id) === "needs") ? "needs" : others.length ? "unseen" : undefined;
  // Every open Space (switcher order, ⌃1–9), then "Open Space…".
  const items: MenuItemProps[] = p.spaces.map((sp, i) => {
    const on = sp.id === p.current;
    const attn = on ? undefined : p.attention.get(sp.id);
    return {
      label: sp.name,
      text: sp.name,
      // Marked left-to-right: the folder is clipped at its start (styles.css), keeping its end.
      detail: `\u200e${shortPath(sp.root)}\u200e`,
      icon: <SpaceIcon space={sp} />,
      accessory: attn && <StatusDot state={attn} size="sm" label={attn === "needs" ? "Needs you" : "Done"} />,
      checked: on,
      shortcut: i < 9 ? `⌃${i + 1}` : undefined,
      className: "space-item",
      // ⌘-click: the Space in a new window.
      onSelect: ({ metaKey }) => (sp.id !== p.current || metaKey) && p.onShow(sp.id, metaKey ? { newWindow: true } : undefined),
      onContextMenu: () => p.onMenu(sp),
    };
  });
  // No Spaces yet: the core hasn't sent its first snapshot (there's always Home
  // after it), so there is nothing to pick and the picker couldn't open one.
  if (!p.spaces.length)
    return (
      <div className="spacebar">
        <span className="space-trigger pending">Connecting…</span>
      </div>
    );
  return (
    <div className="spacebar">
      <button
        ref={button}
        className={`space-trigger ${open ? "open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={shown ? shortPath(shown.root) : undefined}
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => (e.preventDefault(), setOpen(false), shown && p.onMenu(shown))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") e.preventDefault(), setOpen(true);
        }}
      >
        {shown && <SpaceIcon space={shown} />}
        <span ref={name} className="space-name">{shown?.name ?? "Spaces"}</span>
        {mark && (
          <Badge size="sm" solid tone={mark === "needs" ? "warning" : "success"} tip={`${others.length} other Space${others.length === 1 ? "" : "s"} ${mark === "needs" ? "need you" : "finished"}`}>
            {others.length}
          </Badge>
        )}
        <Symbol name="chevron.down" size={ICON.disclosure} />
      </button>
      <Menu
        anchor={button}
        open={open}
        onClose={() => setOpen(false)}
        label="Spaces"
        className="space-menu"
        placement="below"
        align="center"
        marks="row"
        inline
        items={[...items, null, { label: "Open Space…", icon: "plus", shortcut: "⌘O", className: "space-item space-item-open", onSelect: p.onPicker }]}
      />
    </div>
  );
}

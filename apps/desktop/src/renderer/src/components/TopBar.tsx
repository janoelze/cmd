// The top bar (docs/21-sidebars.md): the app window's drag region, full width,
// over the sidebars and the board. The Space switcher in the middle, like a
// window title; at the right end Search (the palette's search), the view modes,
// a divider and New…, as plain buttons like the footer's.

import { ICON, IconButton } from "@cmd/ui";
import { prettyAccelerator, type CommandId } from "../../../shared/commands.ts";
import { useKeybindings } from "../keybindings.ts";
import type { ViewMode } from "../layouts.ts";

const MODES: { value: ViewMode; icon: string; tip: string }[] = [
  { value: "focus", icon: "rectangle", tip: "Focus" },
  { value: "grid", icon: "square.grid.2x2", tip: "Grid" },
  { value: "strip", icon: "rectangle.split.3x1", tip: "Strip" },
  { value: "canvas", icon: "rectangle.3.group", tip: "Canvas" },
];

interface Props {
  /** The Space switcher (SpaceBar). */
  spaceBar: React.ReactNode;
  mode: ViewMode;
  run: (id: CommandId) => void;
  onNew: () => void;
}

export function TopBar(p: Props) {
  const keys = useKeybindings();
  return (
    <header className="topbar">
      <div className="topbar-lead" />
      <div className="topbar-center">{p.spaceBar}</div>
      <div className="topbar-trail">
        <IconButton icon="magnifyingglass" label="Search" shortcut={prettyAccelerator(keys.bindings["view.search"]?.[0])} iconSize={ICON.bar} onClick={() => p.run("view.search")} />
        <span className="bar-sep" aria-hidden />
        <div className="topbar-modes" role="group" aria-label="View">
          {MODES.map((m) => (
            <IconButton
              key={m.value}
              icon={m.icon}
              label={m.tip}
              shortcut={prettyAccelerator(keys.bindings[`view.${m.value}`]?.[0])}
              iconSize={ICON.bar}
              pressed={p.mode === m.value}
              onClick={() => p.run(`view.${m.value}`)}
            />
          ))}
        </div>
        <span className="bar-sep" aria-hidden />
        <IconButton icon="plus" label="New…" shortcut={prettyAccelerator(keys.bindings["file.new"]?.[0])} iconSize={ICON.bar} onClick={p.onNew} />
      </div>
    </header>
  );
}

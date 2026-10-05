// The top bar (docs/21-sidebars.md): the app window's drag region, full width,
// over the sidebars and the workspace. The traffic lights, then the Space
// switcher; the view modes and New… at the right end.

import { IconButton, Segmented } from "@cmd/ui";
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
  const modes = MODES.map((m) => ({ ...m, shortcut: prettyAccelerator(keys.bindings[`view.${m.value}`]?.[0]) }));
  return (
    <header className="topbar">
      <div className="topbar-lead">{p.spaceBar}</div>
      <div className="topbar-trail">
        <Segmented size="sm" label="View" value={p.mode} options={modes} onChange={(m) => p.run(`view.${m}`)} />
        <IconButton variant="default" size="sm" icon="plus" label="New…" onClick={p.onNew} />
      </div>
    </header>
  );
}

// The top bar (docs/21-sidebars.md): the app window's drag region, full width,
// over the sidebars and the workspace. The traffic lights, then the Space
// switcher; New… at the right end.

import { IconButton } from "@cmd/ui";

interface Props {
  /** The Space switcher (SpaceBar). */
  spaceBar: React.ReactNode;
  onNew: () => void;
}

export function TopBar(p: Props) {
  return (
    <header className="topbar">
      <div className="topbar-lead">{p.spaceBar}</div>
      <div className="topbar-trail">
        <IconButton icon="plus" label="New…" onClick={p.onNew} />
      </div>
    </header>
  );
}

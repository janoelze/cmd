// Reference: what a window shows instead of its content (View state: empty, no
// results, error, loading), with texts of very different lengths at three window
// widths, for how centred titles and texts wrap (pnpm workbench states).

import { Button, View, type ViewStateSpec } from "@cmd/ui";
import { RefWindow } from "./RefWindow.tsx";

const STATES: ViewStateSpec[] = [
  { kind: "empty", icon: "tray", title: "Nothing here", text: "New items show up here." },
  { kind: "empty", icon: "play.rectangle", title: "No scripts here", text: "Nothing to run in ~/src/cmd yet. Scripts in package.json, a Makefile, a justfile and similar files show up here." },
  { kind: "noResults", title: "No matches", text: "Nothing here is called “deploy prod”.", action: <Button>Clear Filter</Button> },
  { kind: "error", title: "Couldn’t read this folder", text: "EACCES: permission denied, open '/Users/jan/src/cmd/packages/core/src/actions/package.json'", action: <Button icon="arrow.clockwise">Try Again</Button> },
  { kind: "empty", icon: "photo.on.rectangle", title: "No pictures in this folder or any of the folders inside it", text: "Drop images on this window." },
];

const WIDTHS = [260, 420, 640] as const;

/** Every state at every width. */
export const Texts = () => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(${WIDTHS.length}, max-content)`, gap: 12 }}>
    {STATES.flatMap((s, i) =>
      WIDTHS.map((w) => (
        <RefWindow key={`${i}-${w}`} icon="macwindow" name={`${s.kind} · ${w}`} size={[w, 220]}>
          <View state={s} />
        </RefWindow>
      )),
    )}
  </div>
);

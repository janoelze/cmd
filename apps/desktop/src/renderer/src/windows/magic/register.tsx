// Magic windows (renderer half): the title from the request, the actions on right-click and in
// the Widgets menu (Change, Stop). A finished build is a package window (windows/package/), whose
// edit view (⌘E) lists its versions (MagicEditor.tsx).

import "./commands.ts"; // its commands (shell/commands/registry.ts)
import { copy } from "../../lib/actions.ts";
import { windowActions } from "../../lib/windowActions.ts";
import { MagicView } from "./MagicView.tsx";
import { registerWindowView, stateStr } from "../registry.ts";

registerWindowView({
  kind: "magic",
  View: MagicView,
  describe: (w) => {
    // No "magic" kind label: the sparkle icon says it, and title bars are short on room.
    // "Magic" is the placeholder title of windows made before the rename.
    const placeholder = w.title === "Magic Widget" || w.title === "Magic";
    // The icon the build picked, else the type's sparkles.
    return { name: placeholder ? stateStr(w, "prompt") || "New Widget" : w.title, kind: null, icon: stateStr(w, "icon") };
  },
  // Change and Stop have no buttons on the window: they are here, on right-click in it or its
  // title bar, and in the Widgets menu (⌘L, ⌘.). Both go through MagicView's window actions.
  actions: (w) => {
    const phase = stateStr(w, "phase");
    const a = () => windowActions(w.id);
    if (phase === "working") return [{ label: "Stop", run: () => a()?.stop?.() }];
    return phase === "ready" ? [{ label: "Change…", run: () => a()?.change?.() }] : [];
  },
  menu: (w) => {
    const prompt = stateStr(w, "prompt");
    return prompt ? [{ label: "Copy Request", run: () => copy(prompt) }] : [];
  },
});

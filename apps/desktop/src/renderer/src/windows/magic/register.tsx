// Magic widgets (renderer half): the title from the request, the actions on right-click and in the View menu (Change, Edit, Refresh, Mute, Fix It).

import "./commands.ts"; // its commands (shell/commands/registry.ts)
import type { AppWindow } from "@cmd/protocol";
import { isIconName } from "@cmd/ui";
import { cmd } from "../../lib/bridge.ts";
import type { MenuEntry } from "../../lib/context.ts";
import { copy } from "../../lib/actions.ts";
import { hostOf } from "../../lib/model.ts";
import { windowActions } from "../../lib/windowActions.ts";
import { MagicView, setEditing } from "./MagicView.tsx";
import { intervalLabel, refreshChoices } from "./magic.ts";
import { registerWindowView, stateStr } from "../registry.ts";

/** Refresh Every ▸: the widget's interval, chosen by the model until the person picks one. */
function refreshEvery(w: AppWindow): MenuEntry {
  const cur = typeof w.state.refresh === "number" ? w.state.refresh : 0;
  // The model's own interval (e.g. 3 s) is listed too, so it shows as checked.
  const choices = refreshChoices(cur);
  return {
    label: "Refresh Every",
    submenu: choices.map((s) => ({
      label: intervalLabel(s),
      checked: s === cur,
      run: () => void cmd.call("magic.setRefresh", { id: w.id, seconds: s }),
    })),
  };
}

registerWindowView({
  kind: "magic",
  View: MagicView,
  describe: (w) => {
    const src = w.state.source as { type?: string; url?: string; command?: string } | null | undefined;
    const place = src?.type === "fetch" ? hostOf(src.url ?? "").replace(/^www\./, "") : src?.type === "command" ? (src.command ?? "").split(/\s+/)[0] : undefined;
    // No "magic" kind label: the sparkle icon says it, and title bars are short on room.
    // "Magic" is the placeholder title of widgets made before the rename.
    const placeholder = w.title === "Magic Widget" || w.title === "Magic";
    // The icon the build picked (manifest.json), else the type's sparkle.
    const icon = stateStr(w, "icon");
    return { name: placeholder ? stateStr(w, "prompt") || "New Widget" : w.title, place, kind: null, icon: isIconName(icon) ? icon : undefined };
  },
  // Change, Refresh and Stop have no buttons on the window (nothing covers a
  // widget): they are here, on right-click in the widget or its title bar, and
  // in the View menu (⌘L, ⌘R, ⌘.). All go through MagicView's window actions.
  actions: (w) => {
    const phase = stateStr(w, "phase");
    const a = () => windowActions(w.id);
    const hasData = !!(w.state.source || w.state.hasData);
    const health = w.state.health as { ok?: boolean } | undefined;
    const problems = Array.isArray(w.state.problems) && w.state.problems.length > 0;
    if (phase === "working") return [{ label: "Stop", run: () => a()?.stop?.() }, { label: "Edit Widget (⌘E)", run: () => setEditing(w.id, true) }];
    return [
      ...(phase === "ready" || stateStr(w, "html") ? [{ label: "Change…", run: () => a()?.change?.() }] : []),
      ...(phase !== "empty" ? [{ label: "Edit Widget (⌘E)", run: () => setEditing(w.id, true) }] : []),
      ...(hasData ? [{ label: "Refresh Now", run: () => a()?.refresh?.() }, refreshEvery(w)] : []),
      ...(w.state.widgetId && hasData ? [{ label: "Mute Notifications", checked: !!w.state.muted, run: () => void cmd.call("magic.mute", { id: w.id, muted: !w.state.muted }) }] : []),
      ...((health && health.ok === false) || problems || w.state.error ? [{ label: "Fix It", run: () => void cmd.call("magic.fix", { id: w.id }) }] : []),
    ];
  },
  menu: (w) => {
    const prompt = stateStr(w, "prompt");
    return [
      ...(prompt ? [{ label: "Copy Request", run: () => copy(prompt) }] : []),
      ...(stateStr(w, "html") ? [{ label: "Copy Widget HTML", run: () => copy(stateStr(w, "html")!) }] : []),
    ];
  },
});

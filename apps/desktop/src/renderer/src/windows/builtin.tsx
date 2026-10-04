// Built-in window views. Each uses the same registration a plugin would.

import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import type { MenuEntry } from "../context.ts";
import { copy } from "../actions.ts";
import { hostOf, shortPath } from "../model.ts";
import { windowActions } from "../windowActions.ts";
import { BrowserView } from "../components/BrowserView.tsx";
import { DEVICES } from "../devices.ts";
import { FilesView } from "../components/FilesView.tsx";
import { MagicView, setEditing } from "../components/MagicView.tsx";
import { intervalLabel, refreshChoices } from "../magic.ts";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";
import { toggleMarkdownEdit } from "./markdown.tsx"; // registers the "markdown" view

/** Right-click → Device Size: show the page at a phone's, tablet's or desktop's size. */
function deviceMenu(w: AppWindow): MenuEntry {
  const current = stateStr(w, "device");
  const pick = (device: string | null) => () => void cmd.call("window.update", { id: w.id, state: { device } }).catch(() => {});
  return {
    label: "Device Size",
    submenu: [
      { label: "Fit Window", checked: !current, run: pick(null) },
      ...DEVICES.flatMap((group): MenuEntry[] => [
        "-",
        ...group.map((d) => ({ label: `${d.name}  ${d.width}×${d.height}`, checked: current === d.id, run: pick(d.id) })),
      ]),
    ],
  };
}

const parentOf = (p: string) => shortPath(p.split("/").slice(0, -1).join("/") || "/");

registerWindowView({
  kind: "browser",
  View: BrowserView,
  describe: (w) => {
    const url = stateStr(w, "url") ?? null;
    const host = hostOf(url).replace(/^www\./, "");
    return { name: (w.title && w.title !== url ? w.title : host) || "New Tab", place: host };
  },
  menu: (w) => {
    const url = stateStr(w, "url");
    return [
      deviceMenu(w),
      ...(url
        ? [
            "-" as const,
            { label: "Open in Default Browser", run: () => cmd.openPath(url) },
            { label: "Copy URL", run: () => copy(url) },
          ]
        : []),
    ];
  },
});

registerWindowView({
  kind: "files",
  View: FilesView,
  describe: (w) => ({ place: parentOf(stateStr(w, "path") ?? "/") }),
  menu: (w) => {
    const p = stateStr(w, "path");
    return p
      ? [
          { label: "Show in Finder", run: () => cmd.openPath(p) },
          { label: "Copy Path", run: () => copy(p) },
        ]
      : [];
  },
});

registerWindowView({
  kind: "text",
  // CodeMirror loads on first use, not at startup.
  View: lazyView(() => import("../components/TextView.tsx").then((m) => m.TextView)),
  describe: (w) => ({ place: stateStr(w, "path") ? parentOf(stateStr(w, "path")!) : undefined }),
  menu: (w) => {
    const p = stateStr(w, "path");
    return p
      ? [
          ...(/\.(md|markdown|mdx)$/i.test(p) ? [{ label: "Preview (⌘E)", run: () => toggleMarkdownEdit(w) }] : []),
          { label: "Open with Default App", run: () => cmd.openPath(p) },
          { label: "Copy Path", run: () => copy(p) },
        ]
      : [];
  },
});

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
    return { name: placeholder ? stateStr(w, "prompt") || "Magic Widget" : w.title, place, kind: null };
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

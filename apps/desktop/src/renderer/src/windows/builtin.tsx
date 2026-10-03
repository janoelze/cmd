// Built-in window views. Each uses the same registration a plugin would.

import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import type { MenuEntry } from "../context.ts";
import { copy } from "../actions.ts";
import { hostOf, shortPath } from "../model.ts";
import { windowActions } from "../windowActions.ts";
import { BrowserView } from "../components/BrowserView.tsx";
import { FilesView } from "../components/FilesView.tsx";
import { MagicView } from "../components/MagicView.tsx";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";
import { toggleMarkdownEdit } from "./markdown.tsx"; // registers the "markdown" view

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
    return url
      ? [
          { label: "Open in Default Browser", run: () => cmd.openPath(url) },
          { label: "Copy URL", run: () => copy(url) },
        ]
      : [];
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

/** Choices for a widget's source interval, in seconds (0: only on Refresh Now). */
const REFRESH_CHOICES = [2, 5, 10, 30, 60, 300, 900, 3600, 0];
function intervalLabel(s: number): string {
  const [n, unit] = s % 3600 === 0 ? [s / 3600, "Hour"] : s % 60 === 0 ? [s / 60, "Minute"] : [s, "Second"];
  return s === 0 ? "Never" : `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Refresh Every ▸: the widget's interval, chosen by the model until the person picks one. */
function refreshEvery(w: AppWindow): MenuEntry {
  const cur = typeof w.state.refresh === "number" ? w.state.refresh : 0;
  // The model's own interval (e.g. 3 s) is listed too, so it shows as checked.
  const choices = REFRESH_CHOICES.includes(cur) ? REFRESH_CHOICES : [...REFRESH_CHOICES.slice(0, -1), cur].sort((x, y) => x - y).concat(0);
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
    return { name: w.title !== "Magic" ? w.title : stateStr(w, "prompt") || "Magic", place, kind: null };
  },
  // Change, Refresh and Stop have no buttons on the window (nothing covers a
  // widget): they are here, on right-click in the widget or its title bar, and
  // in the View menu (⌘L, ⌘R, ⌘.). All go through MagicView's window actions.
  actions: (w) => {
    const phase = stateStr(w, "phase");
    const a = () => windowActions(w.id);
    if (phase === "working") return [{ label: "Stop", run: () => a()?.stop?.() }];
    return [
      ...(phase === "ready" || stateStr(w, "html") ? [{ label: "Change…", run: () => a()?.change?.() }] : []),
      ...(w.state.source ? [{ label: "Refresh Now", run: () => a()?.refresh?.() }, refreshEvery(w)] : []),
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

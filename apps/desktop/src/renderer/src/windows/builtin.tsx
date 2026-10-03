// Built-in window views. Each uses the same registration a plugin would.

import { cmd } from "../bridge.ts";
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
      ...(w.state.source ? [{ label: "Refresh Now", run: () => a()?.refresh?.() }] : []),
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

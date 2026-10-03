// Built-in window views. Each uses the same registration a plugin would.

import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { hostOf, shortPath } from "../model.ts";
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
  describe: (w) => ({ place: parentOf(stateStr(w, "path") ?? "") }),
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
    return { name: w.title !== "Magic" ? w.title : stateStr(w, "prompt") || "Magic", place };
  },
  menu: (w) => {
    const prompt = stateStr(w, "prompt");
    return [
      ...(w.state.source ? [{ label: "Refresh Now", run: () => void cmd.call("magic.refresh", { id: w.id }) }] : []),
      ...(prompt ? [{ label: "Copy Request", run: () => copy(prompt) }] : []),
      ...(stateStr(w, "html") ? [{ label: "Copy Widget HTML", run: () => copy(stateStr(w, "html")!) }] : []),
    ];
  },
});

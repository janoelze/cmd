// Markdown window type (renderer half): title fields, menu and the ⌘E switch to
// the text editor. The view itself (markdown-view.tsx) loads on first use.

import { cmd } from "../bridge.ts";
import { copy, copySummary, selectPane } from "../actions.ts";
import { shortPath } from "../model.ts";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";
/** Where the core keeps session summaries ($CMD_HOME/summaries, else the temp folder's cmd-summaries). */
const SUMMARY_FILE = /\/(cmd-)?summaries\/[^/]+\.md$/;

/** ⌘E: Markdown ⇄ text editor, same window (id, slot and size kept). */
export function toggleMarkdownEdit(win: { id: string; kind: string; state: Record<string, unknown> }): boolean {
  const p = typeof win.state.path === "string" ? win.state.path : "";
  if (win.kind === "markdown") {
    void cmd.call("window.update", { id: win.id, kind: "text" }).then(() => selectPane(win.id));
    return true;
  }
  if (win.kind === "text" && /\.(md|markdown|mdx)$/i.test(p)) {
    void cmd.call("window.update", { id: win.id, kind: "markdown" }).then(() => selectPane(win.id));
    return true;
  }
  return false;
}

registerWindowView({
  kind: "markdown",
  View: lazyView(() => import("./markdown-view.tsx").then((m) => m.MarkdownView)),
  describe: (w) => ({ place: shortPath(dirOf(stateStr(w, "path") ?? "")) }),
  menu: (w) => {
    const p = stateStr(w, "path");
    return [
      { label: "Edit (⌘E)", run: () => toggleMarkdownEdit(w) },
      // Session summaries (docs/20-session-summaries.md): to paste elsewhere.
      ...(p && SUMMARY_FILE.test(p) ? [{ label: "Copy Summary", run: () => void copySummary(p) }] : []),
      ...(p
        ? [
            { label: "Open with Default App", run: () => cmd.openPath(p) },
            { label: "Copy Path", run: () => copy(p) },
          ]
        : []),
    ];
  },
});

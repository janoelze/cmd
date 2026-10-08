// Markdown window type (renderer half): title fields, menu and the ⌘E switch to
// the text editor. The view itself (markdown-view.tsx) loads on first use.

import { cmd } from "../bridge.ts";
import { copy, copySummary } from "../actions.ts";
import { shortPath } from "../model.ts";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";
import { registerPreview, togglePreview } from "./preview.ts";

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";
/** Where the core keeps session summaries ($CMD_HOME/summaries, else the temp folder's cmd-summaries). */
const SUMMARY_FILE = /\/(cmd-)?summaries\/[^/]+\.md$/;

registerPreview("markdown", /\.(md|markdown|mdx)$/i);

registerWindowView({
  kind: "markdown",
  View: lazyView(() => import("./markdown-view.tsx").then((m) => m.MarkdownView)),
  describe: (w) => ({ place: shortPath(dirOf(stateStr(w, "path") ?? "")) }),
  menu: (w) => {
    const p = stateStr(w, "path");
    return [
      { label: "Edit (⌘E)", run: () => togglePreview(w) },
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

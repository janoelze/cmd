// Markdown window type (renderer half): title-bar meta, menu and the ⌘E switch to
// the text editor. The view itself (markdown-view.tsx) loads on first use.

import { cmd } from "../bridge.ts";
import { copy, selectPane } from "../actions.ts";
import { shortPath } from "../model.ts";
import { useWindowStatus } from "../windowActions.ts";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";

function MarkdownMeta({ id, path }: { id: string; path: string }) {
  const status = useWindowStatus(id);
  return (
    <>
      <span className="tile-path">{shortPath(dirOf(path))}</span>
      {status && <span className="tile-usage">{status.label}</span>}
    </>
  );
}

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
  detail: (w) => shortPath(stateStr(w, "path") ?? ""),
  meta: (w) => <MarkdownMeta id={w.id} path={stateStr(w, "path") ?? ""} />,
  menu: (w) => {
    const p = stateStr(w, "path");
    return [
      { label: "Edit (⌘E)", run: () => toggleMarkdownEdit(w) },
      ...(p
        ? [
            { label: "Open with Default App", run: () => cmd.openPath(p) },
            { label: "Copy Path", run: () => copy(p) },
          ]
        : []),
    ];
  },
});

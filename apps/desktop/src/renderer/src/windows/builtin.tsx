// Built-in window views. Each uses the same registration a plugin would.

import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { hostOf, shortPath } from "../model.ts";
import { BrowserView } from "../components/BrowserView.tsx";
import { FilesView } from "../components/FilesView.tsx";
import { TextView } from "../components/TextView.tsx";
import { useWindowStatus } from "../windowActions.ts";
import { registerWindowView, stateStr } from "./registry.ts";
import { toggleMarkdownEdit } from "./markdown.tsx"; // registers the "markdown" view

const folderOf = (p: string) => shortPath(p.split("/").slice(0, -1).join("/") || "/");

registerWindowView({
  kind: "browser",
  View: BrowserView,
  label: (w) => (w.title && w.title !== stateStr(w, "url") ? w.title : hostOf(stateStr(w, "url") ?? null) || "Browser"),
  detail: (w) => hostOf(stateStr(w, "url") ?? null),
  meta: (w) => <span className="tile-path">{hostOf(stateStr(w, "url") ?? null)}</span>,
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
  detail: (w) => shortPath(stateStr(w, "path") ?? ""),
  meta: (w) => <span className="tile-path">{shortPath(stateStr(w, "path") ?? "")}</span>,
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

function TextMeta({ id, path }: { id: string; path: string }) {
  const status = useWindowStatus(id);
  return (
    <>
      <span className="tile-path">{folderOf(path)}</span>
      {status && <span className="tile-usage">{status.label}</span>}
    </>
  );
}

registerWindowView({
  kind: "text",
  View: TextView,
  detail: (w) => shortPath(stateStr(w, "path") ?? ""),
  meta: (w) => <TextMeta id={w.id} path={stateStr(w, "path") ?? ""} />,
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

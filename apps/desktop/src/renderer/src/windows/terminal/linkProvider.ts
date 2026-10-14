// ⌘-click links in terminals (terminals.ts registers the provider per terminal).
import type { IBufferCellPosition, ILink, Terminal } from "@xterm/xterm";
import type { PaneId } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { lineLinks, pickPaths, type CellLink, type Row } from "./links.ts";

// ⌘-click links (URLs, existing file paths). xterm asks the provider only for
// the line under the mouse, when the mouse moves onto it, and caches the reply
// for that line, so cost doesn't grow with output or scrollback: one regex pass
// over a capped line, plus one batched existence check (cached) for path-like
// tokens. Detection runs on hover either way; ⌘ only decides whether the link
// is underlined and opens on click (plain clicks stay selection / the app's).
const LINK_MAX_ROWS = 8; // rows read on each side of the hovered one
const LINK_MAX_CHARS = 2000;
const RESOLVE_TTL = 5000;
const resolved = new Map<string, { at: number; abs: Promise<string | null> }>();
let hovered: ILink | null = null;
let metaDown = false;
const showLinks = (on: boolean): void => {
  metaDown = on;
  // xterm tracks these properties (not the object) on the link under the mouse.
  if (hovered?.decorations) (hovered.decorations.underline = on), (hovered.decorations.pointerCursor = on);
};
window.addEventListener("keydown", (e) => e.key === "Meta" && showLinks(true), true);
window.addEventListener("keyup", (e) => e.key === "Meta" && showLinks(false), true);
window.addEventListener("blur", () => showLinks(false));

/** Absolute paths of those that exist (relative to cwd), cached briefly; one RPC for the misses. */
function resolvePaths(paths: string[], cwd: string): Promise<(string | null)[]> {
  const now = Date.now();
  if (resolved.size > 500) for (const [k, v] of resolved) if (now - v.at > RESOLVE_TTL) resolved.delete(k);
  const miss = paths.filter((p) => !((resolved.get(`${cwd}\0${p}`)?.at ?? 0) > now - RESOLVE_TTL));
  if (miss.length) {
    const call = cmd.call("fs.resolve", { paths: miss, cwd }).catch(() => miss.map(() => null));
    miss.forEach((p, i) => resolved.set(`${cwd}\0${p}`, { at: now, abs: call.then((r) => r[i] ?? null) }));
  }
  return Promise.all(paths.map((p) => resolved.get(`${cwd}\0${p}`)!.abs));
}

export async function openTarget(kind: "url" | "path", target: string): Promise<void> {
  const { openLink, openPath } = await import("../../lib/actions.ts");
  if (kind === "url") openLink(target);
  else void openPath(target, "content");
}

export function linkProvider(term: Terminal, paneId: PaneId) {
  return {
    provideLinks(y: number, done: (links: ILink[] | undefined) => void): void {
      // The logical line around row y (1-based), from the rows on either side:
      // soft wraps and URLs or paths wrapped by the program (lineLinks), with
      // each character's cell, so wide characters and wraps map back exactly.
      const buf = term.buffer.active;
      const rows: Row[] = [];
      const first = Math.max(0, y - 1 - LINK_MAX_ROWS);
      for (let row = first; row < y + LINK_MAX_ROWS; row++) {
        const line = buf.getLine(row);
        if (!line) break;
        let text = "";
        const cells: IBufferCellPosition[] = [];
        const cell = line.getCell(0);
        for (let x = 0; x < line.length; x++) {
          const c = line.getCell(x, cell);
          const ch = c?.getChars() ?? "";
          if (!c || c.getWidth() === 0) continue; // right half of a wide char
          text += ch || " ";
          for (let i = 0; i < (ch.length || 1); i++) cells.push({ x: x + 1, y: row + 1 });
        }
        rows.push({ text, cells, wrapped: line.isWrapped });
      }
      const { urls, paths } = lineLinks(rows, y - 1 - first, term.cols, LINK_MAX_CHARS);
      if (!urls.length && !paths.length) return done(undefined);
      const make = (l: CellLink, open: () => void): ILink => ({
        range: { start: l.start, end: l.end },
        text: l.text,
        decorations: { underline: metaDown, pointerCursor: metaDown },
        activate: (e) => e.metaKey && open(),
        hover(this: ILink) {
          hovered = this;
        },
        leave(this: ILink) {
          if (hovered === this) hovered = null;
        },
      });
      const urlLinks = urls.map((l) => make(l, () => void openTarget("url", l.target)));
      if (!paths.length) return done(urlLinks);
      void import("../../lib/store.ts").then(async ({ getState }) => {
        const cwd = getState().panes.get(paneId)?.cwd;
        const abs = cwd ? await resolvePaths(paths.map((l) => l.target), cwd) : [];
        const links = pickPaths(paths, abs).map(({ link, abs }) => make(link, () => void openTarget("path", abs)));
        done([...urlLinks, ...links].sort((a, b) => a.range.start.y - b.range.start.y || a.range.start.x - b.range.start.x));
      });
    },
  };
}

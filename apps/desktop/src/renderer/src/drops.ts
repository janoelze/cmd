// Drag and drop into the app (docs/22-drag-and-drop.md). One router on the
// document, in the capture phase, sees every drag over the page: from Finder,
// from other apps, and from cmd itself (file drags are native macOS drags,
// drags.ts, so they arrive as files like any other). It finds the window under
// the pointer and asks the drop target that window registered (registerDropTarget:
// terminals, file browsers…). Over a window without one, or the board
// between windows, dropped files and links open (window routing, like the
// palette). Anywhere else a file drop is refused, so it can never replace the
// app's page with the file.
//
// Embedded pages (<webview> browser windows, Magic widgets) get their drags
// natively, in their own process: a page's upload field takes a dragged file.

import type { PaneId } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { openPath } from "./actions.ts";
import { parseUriList } from "./paste.ts";

/** What a drag carries, by kind. Until the drop only the kinds can be read, not the data. */
export interface DragKinds {
  files: boolean;
  urls: boolean;
  text: boolean;
}

export interface DragInfo extends DragKinds {
  /** The element under the pointer (a file browser's row…). */
  target: Element;
  x: number;
  y: number;
  alt: boolean;
  meta: boolean;
}

/** What was dropped: file paths (from Finder, cmd, or file: URLs), other URLs, and plain text. */
export interface DropItems {
  files: string[];
  urls: string[];
  text: string;
}

export type DropEffect = "copy" | "move" | "link";

export interface DropTarget {
  /** What a drop here would do (the pointer's badge), or null to leave it. Asked on every dragover. */
  over(drag: DragInfo): DropEffect | null;
  drop(items: DropItems, drag: DragInfo): void;
  /** The drag left, or was dropped or cancelled: undo what `over` showed. */
  leave?(): void;
}

const targets = new Map<PaneId, DropTarget>();

/** The window's drop target (one per window; the latest registration wins). Returns its removal. */
export function registerDropTarget(paneId: PaneId, target: DropTarget): () => void {
  targets.set(paneId, target);
  return () => targets.get(paneId) === target && targets.delete(paneId);
}

export function dragKinds(dt: DataTransfer | null): DragKinds {
  const types = dt?.types ?? [];
  return { files: types.includes("Files"), urls: types.includes("text/uri-list"), text: types.includes("text/plain") };
}

export function readDrop(dt: DataTransfer): DropItems {
  const fromList = parseUriList(dt.getData("text/uri-list"));
  const files = [...new Set([...[...dt.files].map((f) => cmd.pathForFile(f)).filter(Boolean), ...fromList.files])];
  return { files, urls: fromList.urls, text: dt.getData("text/plain") };
}

/** Over the board, or a window that has no target of its own: open dropped files and links. */
const openTarget: DropTarget = {
  over: (d) => (d.files || d.urls ? "copy" : null),
  drop: (items) => {
    for (const p of [...items.files, ...items.urls]) void openPath(p);
  },
};

/** The window under the pointer, and the target that takes this drag there. */
function resolve(drag: DragInfo): { el: HTMLElement | null; target: DropTarget | null; effect: DropEffect | null } {
  const el = drag.target.closest<HTMLElement>("[data-pane]");
  const own = el ? targets.get(el.dataset.pane as PaneId) : undefined;
  const effect = own?.over(drag) ?? null;
  if (effect) return { el, target: own!, effect };
  const fallback = el || drag.target.closest(".main") ? openTarget.over(drag) : null;
  return { el, target: fallback ? openTarget : null, effect: fallback };
}

/**
 * The effect to show: the target's, if the drag's source allows it, else one it
 * does (a drop with an effect the source doesn't allow is refused). Finder allows
 * all; a native drag that cmd starts may allow only copy, and then the badge says
 * copy though the target still does what it would (a file browser moves).
 */
export function allowedEffect(want: DropEffect, allowed: string): DropEffect | null {
  if (allowed === "all" || allowed === "uninitialized") return want;
  const ok = (e: DropEffect) => allowed === e || allowed.toLowerCase().includes(e);
  return ok(want) ? want : (["copy", "move", "link"] as const).find(ok) ?? null;
}

const info = (e: DragEvent): DragInfo => ({ ...dragKinds(e.dataTransfer), target: e.target as Element, x: e.clientX, y: e.clientY, alt: e.altKey, meta: e.metaKey });

/** The window being shown as the drop's target, and the target that may have marked something in it. */
let shown: { el: HTMLElement | null; target: DropTarget | null } = { el: null, target: null };
function show(el: HTMLElement | null, target: DropTarget | null): void {
  if (shown.target && shown.target !== target) shown.target.leave?.();
  if (shown.el !== el) shown.el?.classList.remove("drop-over");
  el?.classList.add("drop-over");
  shown = { el, target };
}

/**
 * dragover keeps coming (every ~50ms) while a drag is over the page, even at rest;
 * when it stops, the drag left the window or was cancelled. dragleave can't tell
 * that apart from moving between elements, and a cancel needn't send one.
 */
const GONE_MS = 300;

/** Install the router (once, at startup). */
export function installDrops(): void {
  let gone: ReturnType<typeof setTimeout> | undefined;
  const over = (e: DragEvent) => {
    clearTimeout(gone);
    gone = setTimeout(() => show(null, null), GONE_MS);
    const drag = info(e);
    const { el, target, effect } = resolve(drag);
    if (!effect) {
      show(null, null);
      // Not ours to take: text drags go on to editors and fields; files are refused.
      if (drag.files) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "none";
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = allowedEffect(effect, e.dataTransfer!.effectAllowed) ?? "none";
    show(target === openTarget ? null : el, target);
  };
  document.addEventListener("dragenter", over, true);
  document.addEventListener("dragover", over, true);
  document.addEventListener("dragend", () => show(null, null), true);
  document.addEventListener(
    "drop",
    (e) => {
      const drag = info(e);
      const { target, effect } = resolve(drag);
      clearTimeout(gone);
      show(null, null);
      if (!effect || !target) {
        if (drag.files) e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      target.drop(readDrop(e.dataTransfer!), drag);
    },
    true,
  );
}

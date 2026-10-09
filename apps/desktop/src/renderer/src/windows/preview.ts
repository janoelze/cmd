// Previews: window types that show a file rendered (Markdown, a JSON tree) and
// switch with the text editor in place on ⌘E (same window: id, slot and size
// kept). A preview says which files it shows; the switch carries the line
// you're on across when both sides know it (windowActions' line).

import { cmd } from "../bridge.ts";
import { selectPane } from "../actions.ts";
import { windowActions } from "../windowActions.ts";

const previews: { kind: string; ext: RegExp }[] = [];

/** `kind` previews files whose path matches `ext`. */
export function registerPreview(kind: string, ext: RegExp): void {
  previews.push({ kind, ext });
}

/** The preview kind for a file, if any. */
export function previewFor(path: string): string | undefined {
  return previews.find((p) => p.ext.test(path))?.kind;
}

export function isPreview(kind: string): boolean {
  return previews.some((p) => p.kind === kind);
}

/** ⌘E: preview ⇄ text editor, same window. False: not a window that switches. */
export function togglePreview(win: { id: string; kind: string; state: Record<string, unknown> }): boolean {
  const p = typeof win.state.path === "string" ? win.state.path : "";
  // A preview flips to text only for a file it previews (an Image window on a .png has no text side).
  const target = isPreview(win.kind) ? (previewFor(p) === win.kind ? "text" : undefined) : win.kind === "text" && p ? previewFor(p) : undefined;
  if (!target) return false;
  const line = windowActions(win.id)?.line?.();
  const reveal = line ? { line, column: null, text: null, at: Date.now() } : undefined;
  void cmd.call("window.update", { id: win.id, kind: target, ...(reveal ? { state: { reveal } } : {}) }).then(() => selectPane(win.id));
  return true;
}

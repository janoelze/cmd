// What a text window does when its file changed on disk, decided by content.
// Not by mtime: a save's own stat can already see the next writer's file (an agent
// writing right after ⌘S), and its mtime then passes for "our own save" while the
// text on disk is someone else's.

/**
 * - `clean`: the disk has what the buffer has (our own save, or the same edit): nothing to merge, the buffer is saved.
 * - `unchanged`: the disk still has what we last saved or loaded (our own save's echo, a touch); unsaved edits stay.
 * - `conflict`: someone else's text, and there are unsaved edits: ask.
 * - `reload`: someone else's text, nothing unsaved: merge it in.
 */
export type DiskChange = "clean" | "unchanged" | "conflict" | "reload";

export function diskChange(disk: string, buffer: string, saved: string | null, dirty: boolean): DiskChange {
  if (disk === buffer) return "clean";
  if (saved !== null && disk === saved) return "unchanged";
  return dirty ? "conflict" : "reload";
}

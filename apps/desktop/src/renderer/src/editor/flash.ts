// Changes made to an editor from outside (Jam's AI), applied line by line
// and shown for a moment: the lines that changed light up and fade (the class
// names are styled where the editor is used, jam.css), the characters that
// changed within a line a little stronger. Only what changed moves; the cursor
// and the rest of the text stay where they are.

import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** How long a change stays marked; the fade is the CSS animation of the same length. */
const FLASH_MS = 2000;

const flash = StateEffect.define<{ lines: number[]; spans: { from: number; to: number }[] } | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flash)) continue;
      if (!e.value) return Decoration.none;
      const marks: Range<Decoration>[] = [];
      for (const at of e.value.lines) marks.push(Decoration.line({ class: "cm-flash-line" }).range(tr.state.doc.line(at).from));
      for (const s of e.value.spans) if (s.to > s.from) marks.push(Decoration.mark({ class: "cm-flash-text" }).range(s.from, s.to));
      set = Decoration.set(marks, true);
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The extension that draws the marks. */
export const flashChanges = [flashField];

/** Longest common subsequence of lines: pairs of [index in a, index in b]. */
function commonLines(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length;
  const len = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i]![j] = a[i] === b[j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) out.push([i++, j++]);
    else if (len[i + 1]![j]! >= len[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/**
 * What turns `old` into `next` line by line: the changes (offsets in `old`), the
 * new text's changed lines (1-based) and, for a line replaced by one line, the
 * characters that changed in it (offsets in `next`).
 */
export function diffLines(old: string, next: string): { changes: { from: number; to?: number; insert: string }[]; lines: number[]; spans: { from: number; to: number }[] } {
  const a = old.split("\n"), b = next.split("\n");
  const changes: { from: number; to?: number; insert: string }[] = [];
  const lines: number[] = [];
  const spans: { from: number; to: number }[] = [];
  if (old === next) return { changes, lines, spans };
  const pairs = [...commonLines(a, b), [a.length, b.length] as [number, number]];
  // Offsets of each line's start in the old and new text.
  const startA: number[] = [], startB: number[] = [];
  a.reduce((at, l, i) => ((startA[i] = at), at + l.length + 1), 0);
  b.reduce((at, l, i) => ((startB[i] = at), at + l.length + 1), 0);
  let i = 0, j = 0;
  for (const [pi, pj] of pairs) {
    if (pi > i || pj > j) {
      // Old lines i..pi-1 became new lines j..pj-1.
      const added = b.slice(j, pj);
      if (pi < a.length) changes.push({ from: startA[i]!, to: startA[pi]!, insert: added.map((l) => l + "\n").join("") });
      else if (i < a.length && added.length) changes.push({ from: startA[i]!, to: old.length, insert: added.join("\n") });
      else if (i < a.length) changes.push({ from: i > 0 ? startA[i]! - 1 : 0, to: old.length, insert: "" });
      else changes.push({ from: old.length, insert: "\n" + added.join("\n") });
      for (let k = j; k < pj; k++) {
        lines.push(k + 1);
        // One old line replaced by one new line: mark what changed within it.
        if (pi - i === pj - j) {
          const was = a[i + (k - j)]!, now = b[k]!;
          let s = 0;
          while (s < was.length && s < now.length && was[s] === now[s]) s++;
          let e = 0;
          while (e < was.length - s && e < now.length - s && was[was.length - 1 - e] === now[now.length - 1 - e]) e++;
          spans.push({ from: startB[k]! + s, to: startB[k]! + now.length - e });
        }
      }
    }
    i = pi + 1;
    j = pj + 1;
  }
  return { changes, lines, spans };
}

/** Turn the editor's text into `next`, changing only the lines that differ, and mark them for a moment. */
export function applyAndFlash(view: EditorView, next: string): void {
  const { changes, lines, spans } = diffLines(view.state.doc.toString(), next);
  if (!changes.length) return;
  view.dispatch({ changes, userEvent: "input.ai" });
  view.dispatch({ effects: flash.of({ lines: lines.filter((l) => l <= view.state.doc.lines), spans: spans.filter((s) => s.to <= view.state.doc.length) }) });
  setTimeout(() => view.dispatch({ effects: flash.of(null) }), FLASH_MS);
}

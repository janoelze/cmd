// Find in rendered HTML (a Markdown preview): matches over the element's text,
// across inline elements (**bold** words, links), marked with the CSS Custom
// Highlight API, so the DOM isn't touched. One registry for the page: every
// window's matches are in the same two highlights (::highlight(find) and
// ::highlight(find-current), styled in the kit).

import type { FindResults } from "@cmd/ui";
import { findRegExp, type Findable } from "./find.tsx";

const all = new Map<object, Range[]>();
const current = new Map<object, Range>();

function paint() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.set("find", new Highlight(...[...all.values()].flat()));
  CSS.highlights.set("find-current", new Highlight(...current.values()));
}

/**
 * The element's text as one string, and where each text node starts in it. With
 * `within`, only text inside those elements, each one apart (a match never spans two).
 */
function textOf(root: HTMLElement, within?: string): { text: string; nodes: { node: Text; at: number }[] } {
  const nodes: { node: Text; at: number }[] = [];
  let text = "";
  let last: Element | null = null;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (within) {
      const own = n.parentElement?.closest(within) ?? null;
      if (!own) continue;
      if (own !== last) (text += "\u0000"), (last = own);
    }
    nodes.push({ node: n, at: text.length });
    text += n.data;
  }
  return { text, nodes };
}

/** A DOM point for an offset into textOf's string. */
function point(nodes: { node: Text; at: number }[], offset: number, end: boolean): [Text, number] {
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (nodes[mid]!.at < offset || (!end && nodes[mid]!.at === offset)) lo = mid;
    else hi = mid - 1;
  }
  const n = nodes[lo]!;
  return [n.node, Math.min(offset - n.at, n.node.data.length)];
}

/** Counting stops here. */
const LIMIT = 5000;

export function domFindable(root: () => HTMLElement | null, at: { within?: string; onCurrent?: (el: Element) => void } = {}): Findable {
  const key = {};
  let ranges: Range[] = [];
  let index = -1;
  const show = (report: (r: FindResults | null) => void, more: boolean) => {
    const r = ranges[index];
    if (r) {
      current.set(key, r);
      const el = r.startContainer.parentElement;
      if (el && at.onCurrent) at.onCurrent(el);
      else (el ?? root())?.scrollIntoView({ block: "center" });
    } else current.delete(key);
    paint();
    report({ index, count: ranges.length, more });
  };
  return {
    find: (query, o, step, report) => {
      const el = root();
      const re = query ? findRegExp(query, o) : null;
      if (!el || !re) {
        ranges = [];
        index = -1;
        all.delete(key);
        current.delete(key);
        paint();
        return report(query ? { index: -1, count: 0 } : null);
      }
      // Found again each time: the preview re-renders when the file changes.
      const was = ranges[index];
      const { text, nodes } = textOf(el, at.within);
      ranges = [];
      for (const m of text.matchAll(re)) {
        if (!m[0]) continue;
        const r = document.createRange();
        r.setStart(...point(nodes, m.index, false));
        r.setEnd(...point(nodes, m.index + m[0].length, true));
        ranges.push(r);
        if (ranges.length >= LIMIT) break;
      }
      all.set(key, ranges);
      if (!ranges.length) index = -1;
      else if (step === 0) {
        // As you type: the first match from where the current one was.
        const after = (r: Range) => {
          try {
            return r.compareBoundaryPoints(Range.START_TO_START, was!) >= 0;
          } catch {
            return true; // the old match's text was replaced
          }
        };
        const from = was ? ranges.findIndex(after) : 0;
        index = from < 0 ? 0 : from;
      } else index = (Math.max(index, step > 0 ? -1 : 0) + step + ranges.length) % ranges.length;
      show(report, ranges.length >= LIMIT);
    },
    clear: () => {
      ranges = [];
      index = -1;
      all.delete(key);
      current.delete(key);
      paint();
    },
    selection: () => {
      const sel = window.getSelection();
      const el = root();
      return sel && el && sel.anchorNode && el.contains(sel.anchorNode) ? sel.toString() : "";
    },
  };
}

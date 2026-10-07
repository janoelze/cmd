// Find in a CodeMirror editor with the app's FindBar instead of CodeMirror's own
// panel. The panel stays (it's what turns match highlighting on), drawn as
// nothing; the bar sets the query and steps through @codemirror/search's
// commands, and counts the matches itself.

import { EditorSelection, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { closeSearchPanel, findNext, findPrevious, openSearchPanel, replaceAll, replaceNext, search, searchPanelOpen, SearchQuery, setSearchQuery } from "@codemirror/search";
import type { FindOptions, FindResults } from "@cmd/ui";
import type { Findable } from "../find.tsx";

/** Counting stops here ("5000+"). */
const COUNT_LIMIT = 5000;

/** CodeMirror's search, with an empty panel in place of its own. */
export const findPanel: Extension = search({
  top: true,
  createPanel: () => {
    const dom = document.createElement("div");
    dom.hidden = true;
    return { dom };
  },
});

const queryOf = (q: string, o: FindOptions, replace = "") => new SearchQuery({ search: q, caseSensitive: o.caseSensitive, regexp: o.regex, wholeWord: o.wholeWord, replace });

/** Where the selection is among the query's matches, and how many there are. */
function count(view: EditorView, q: SearchQuery): FindResults {
  if (!q.valid) return { index: -1, count: 0 };
  const sel = view.state.selection.main;
  const cur = q.getCursor(view.state);
  let n = 0;
  let index = -1;
  for (let m = cur.next(); !m.done; m = cur.next()) {
    if (m.value.from === sel.from && m.value.to === sel.to) index = n;
    if (++n >= COUNT_LIMIT) return { index, count: n, more: true };
  }
  return { index, count: n };
}

export function editorFindable(view: () => EditorView | null, editable: () => boolean): Findable {
  const set = (v: EditorView, q: SearchQuery) => {
    if (!searchPanelOpen(v.state)) openSearchPanel(v);
    v.dispatch({ effects: setSearchQuery.of(q) });
  };
  return {
    find: (query, o, step, report) => {
      const v = view();
      if (!v) return;
      const q = queryOf(query, o);
      set(v, q);
      if (!query || !q.valid) return report(query ? { index: -1, count: 0 } : null);
      // As you type: from where the current match starts, so it grows in place.
      if (step === 0) v.dispatch({ selection: EditorSelection.cursor(v.state.selection.main.from) });
      (step < 0 ? findPrevious : findNext)(v);
      report(count(v, q));
    },
    clear: () => {
      const v = view();
      if (v && searchPanelOpen(v.state)) closeSearchPanel(v);
    },
    selection: () => {
      const v = view();
      if (!v) return "";
      const s = v.state.selection.main;
      return v.state.sliceDoc(s.from, s.to);
    },
    replace: (query, o, by, all, report) => {
      const v = view();
      if (!v || !editable()) return;
      const q = queryOf(query, o, by);
      set(v, q);
      (all ? replaceAll : replaceNext)(v);
      report(count(v, q));
    },
  };
}

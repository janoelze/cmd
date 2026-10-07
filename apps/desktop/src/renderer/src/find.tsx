// Find in a window (⌘F ⌘G ⇧⌘G ⌘E), the app's side of the kit's FindBar. A
// window describes how to find in its content (a Findable) and gets the bar, its
// state and a `request` for the commands. The query and options are shared like
// macOS's find pasteboard: ⌘E and every search set them, ⌘G in any window uses them.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FindBar, NO_FIND_OPTIONS, type FindBarHandle, type FindOptions, type FindResults } from "@cmd/ui";

export type FindRequest = "open" | "next" | "prev" | "selection" | "replace" | "close";

export interface Findable {
  /** Which options it honours; omitted: all. */
  supports?: Partial<Record<keyof FindOptions, boolean>>;
  /**
   * Find `query` and mark its matches; an empty query clears them. `step` 0: as
   * you type, from the current match (or the cursor); 1 / −1: the next or previous.
   * Results go to `report`, now or when the content has counted.
   */
  find: (query: string, o: FindOptions, step: 0 | 1 | -1, report: (r: FindResults | null) => void) => void;
  /** The bar closed: unmark everything. */
  clear: () => void;
  /** The selected text, to find (one line); "" if none. */
  selection?: () => string | Promise<string>;
  /** Text that can be edited: replace the current match, or all of them. */
  replace?: (query: string, o: FindOptions, by: string, all: boolean, report: (r: FindResults | null) => void) => void;
}

let shared = { query: "", options: NO_FIND_OPTIONS };
const oneLine = (s: string) => (s.includes("\n") ? "" : s);

export interface WindowFind {
  open: boolean;
  request: (r: FindRequest) => void;
  /** The bar, while it's open. */
  bar: ReactNode;
}

export function useFind(findable: Findable, o: { floating?: boolean; placeholder?: string; onClose?: () => void } = {}): WindowFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState(shared.options);
  const [results, setResults] = useState<FindResults | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [by, setBy] = useState("");
  const handle = useRef<FindBarHandle>(null);
  const f = useRef(findable);
  f.current = findable;
  const cur = useRef({ open, query, options });
  cur.current = { open, query, options };
  const onClose = useRef(o.onClose);
  onClose.current = o.onClose;

  // Typing and toggles find from the current match.
  useEffect(() => {
    if (!open) return;
    shared = { query, options };
    if (!query) setResults(null);
    f.current.find(query, options, 0, setResults);
  }, [open, query, options]);

  const show = useCallback((q: string) => {
    setQuery(q);
    if (cur.current.open) handle.current?.focus();
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    cur.current.open = false;
    setOpen(false);
    setResults(null);
    f.current.clear();
    onClose.current?.();
  }, []);

  const request = useCallback(
    async (r: FindRequest) => {
      const s = cur.current;
      if (r === "close") {
        if (s.open) close();
      } else if (r === "selection") {
        const sel = oneLine((await f.current.selection?.()) ?? "");
        if (!sel) return;
        shared = { ...shared, query: sel };
        if (s.open) setQuery(sel);
      } else if (r === "open" || r === "replace") {
        const sel = oneLine((await f.current.selection?.()) ?? "");
        if (r === "replace" && f.current.replace) setReplacing(true);
        show(sel || (s.open ? s.query : shared.query));
      } else if (!s.open || !s.query) {
        // ⌘G with the bar closed: the shared query, from the cursor.
        if (shared.query) (setOptions(shared.options), show(shared.query));
        else show("");
      } else f.current.find(s.query, s.options, r === "next" ? 1 : -1, setResults);
    },
    [show, close],
  );

  const rep = findable.replace;
  const bar = open ? (
    <FindBar
      ref={handle}
      query={query}
      onQuery={setQuery}
      options={options}
      onOptions={setOptions}
      supports={findable.supports}
      results={results}
      onStep={(d) => f.current.find(query, options, d, setResults)}
      onClose={close}
      floating={o.floating}
      placeholder={o.placeholder}
      replace={
        rep && {
          open: replacing,
          onOpen: setReplacing,
          value: by,
          onValue: setBy,
          onReplace: (all) => rep(query, options, by, all, setResults),
        }
      }
    />
  ) : null;
  return { open, request, bar };
}

/** Escape a query for a RegExp, and build the one the options say. Null: an invalid regex (still typing). */
export function findRegExp(query: string, o: FindOptions, flags = "g"): RegExp | null {
  const src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(o.wholeWord ? `\\b(?:${src})\\b` : src, o.caseSensitive ? flags : flags + "i");
  } catch {
    return null;
  }
}

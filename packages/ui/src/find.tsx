// Find: the bar every window's ⌘F shows, and highlighted matches in text.
// The bar is toolbar items in a WindowToolbar: a second row under a window's own
// toolbar, or `floating` over content that has none (a terminal). It gives way
// like any toolbar: the option toggles move into ⋯ first, the field, its count
// and the arrows stay. It is controlled: the window does the finding and says
// what it found; ↩ / ⇧↩ step, ⎋ closes.

import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { ToolbarButton, ToolbarGroup, ToolbarSearchField, WindowToolbar } from "./toolbar.tsx";

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const NO_FIND_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

/** What a window found: `index` −1 while it doesn't know which one is current; `count` −1 while searching. */
export interface FindResults {
  index: number;
  count: number;
  /** More than `count` (a terminal stops counting): "12+". */
  more?: boolean;
}

export interface FindBarHandle {
  /** Focus the field and select its text. */
  focus: () => void;
}

/** The count in the field: "3 of 12", "12", "No matches", nothing while there's no query. */
export function findCount(query: string, r: FindResults | null): string | undefined {
  if (!query || !r || r.count < 0) return undefined;
  if (r.count === 0) return "No matches";
  const n = `${r.count}${r.more ? "+" : ""}`;
  return r.index >= 0 ? `${r.index + 1} of ${n}` : n;
}

/** Text drawn as a toolbar icon ("Aa", ".*"): a mark no symbol says. */
export function Glyph({ children }: { children: ReactNode }) {
  return (
    <span className="ui-glyph" aria-hidden>
      {children}
    </span>
  );
}

export interface FindBarProps {
  query: string;
  onQuery: (q: string) => void;
  options: FindOptions;
  onOptions: (o: FindOptions) => void;
  /** Which toggles this window can honour (pdf.js has no regex); omitted: all. */
  supports?: Partial<Record<keyof FindOptions, boolean>>;
  results: FindResults | null;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
  /** Over the content, as wide as its items (windows without a toolbar). */
  floating?: boolean;
  /** "Find", "Find in PDF". */
  placeholder?: string;
}

/** Find in a window: ↩ next, ⇧↩ previous, ⎋ closes (a first ⎋ clears the field). */
export const FindBar = forwardRef<FindBarHandle, FindBarProps>(function FindBar(p, ref) {
  const input = useRef<HTMLInputElement>(null);
  const focus = () => (input.current?.focus(), input.current?.select());
  useImperativeHandle(ref, () => ({ focus }), []);
  useEffect(focus, []);

  const can = (k: keyof FindOptions) => p.supports?.[k] ?? true;
  const toggle = (k: keyof FindOptions) => p.onOptions({ ...p.options, [k]: !p.options[k] });
  const none = p.results?.count === 0;

  return (
    <WindowToolbar label="Find" floating={p.floating} className="ui-find">
      <ToolbarSearchField
        ref={input}
        value={p.query}
        placeholder={p.placeholder ?? "Find"}
        minWidth={110}
        maxWidth={p.floating ? 240 : undefined}
        // Floating, the bar is as wide as its items: the field asks for its full width, and gives way from there.
        style={p.floating ? { width: 240 } : undefined}
        count={findCount(p.query, p.results)}
        aria-invalid={(p.query && none) || undefined}
        onChange={p.onQuery}
        onEscape={p.onClose}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          p.onStep(e.shiftKey ? -1 : 1);
        }}
      />
      {can("caseSensitive") && <ToolbarButton icon={<Glyph>Aa</Glyph>} label="Match Case" pressed={p.options.caseSensitive} onClick={() => toggle("caseSensitive")} priority={3} />}
      {can("wholeWord") && <ToolbarButton icon={<Glyph>ab</Glyph>} label="Whole Words" pressed={p.options.wholeWord} onClick={() => toggle("wholeWord")} priority={2} className="ui-glyph-word" />}
      {can("regex") && <ToolbarButton icon={<Glyph>.*</Glyph>} label="Regular Expression" pressed={p.options.regex} onClick={() => toggle("regex")} priority={1} />}
      <ToolbarGroup>
        <ToolbarButton icon="chevron.up" label="Previous" shortcut="⇧⌘G" disabled={!p.query || none} onClick={() => p.onStep(-1)} />
        <ToolbarButton icon="chevron.down" label="Next" shortcut="⌘G" disabled={!p.query || none} onClick={() => p.onStep(1)} />
      </ToolbarGroup>
      <ToolbarButton icon="xmark" label="Close" shortcut="⎋" onClick={p.onClose} />
    </WindowToolbar>
  );
});

/** Text with the matches marked: \x01…\x02 around each (what search snippets carry). */
export function Highlight({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\x01[^\x02]*\x02)/);
  return (
    <span className={className}>
      {parts.map((s, i) => (s.startsWith("\x01") ? <mark key={i} className="ui-match">{s.slice(1, -1)}</mark> : s ? <span key={i}>{s}</span> : null))}
    </span>
  );
}

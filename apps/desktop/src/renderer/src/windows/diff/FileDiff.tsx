// FileDiff: one file's change, from its whole text before and after (not a patch), in
// a read-only CodeMirror (@codemirror/merge) in the editor's look and the file's
// language. Unified (the old lines above the new, in place) or split (side by side);
// unchanged stretches folded to a bar that opens them; the characters that changed
// within a line marked; a ruler beside the scrollbar with a mark per change; next and
// previous change. `others`: other versions of the same file from the same base (other
// agents'): lines they change too are marked in the gutter, the clash. A new `after`
// (the agent wrote again) changes only what differs and lights it up for a moment;
// the scroll stays where it is.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChangeSet, Compartment, EditorState, Prec, RangeSet, RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutterLineClass, lineNumbers, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk, presentableDiff, unifiedMergeView, type Chunk } from "@codemirror/merge";
import { useTheme } from "@cmd/ui/themes";
import { useStoreValue } from "../../lib/store.ts";
import { syntax } from "../../editor/syntax.ts";
import { appTheme, minimalChange } from "../../editor/theme.ts";
import { applyAndFlash, flashChanges } from "../../editor/flash.ts";
import "./file-diff.css";

/** Another version of the file from the same base: its lines that change the same base lines as this one are a clash. */
export interface OtherVersion {
  name: string;
  after: string;
}

export interface FileDiffProps {
  /** The file's path (its language comes from the name). */
  path: string;
  /** The whole file at the base (empty for a new file). */
  before: string;
  /** The whole file now (empty for a deleted one). */
  after: string;
  mode?: "unified" | "split";
  others?: readonly OtherVersion[];
  /** Lines of context kept around each change; longer unchanged stretches fold. */
  context?: number;
  /** Where you are among the changes: how many, and the one at the top of the view (0-based; -1 above the first). */
  onPlace?: (p: { count: number; at: number }) => void;
}

/** Next and previous change, for buttons beside it. */
export interface FileDiffHandle {
  next(): void;
  prev(): void;
}

/** Above this many lines a new `after` is applied as one change, without lighting up the lines (the line match is quadratic). */
const FLASH_MAX_LINES = 2000;

/**
 * The diff's look over the editor's: the kit Diff's type (the code font at --text-xs, 1.5),
 * so every row is one line of the same grid: code, deleted lines and folded stretches alike;
 * no padding above the first line; git colours from the theme.
 */
const diffTheme = Prec.highest(
  EditorView.theme({
    "&": { fontSize: "var(--text-xs)" },
    ".cm-scroller": { lineHeight: "1.5" },
    ".cm-content": { padding: "0 0 var(--space-6)" },
    ".cm-line, .cm-deletedChunk .cm-deletedLine": { padding: "0 var(--inset) 0 var(--space-2)" },
    ".cm-gutters": { borderRight: "none" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--space-1) 0 var(--inset)", minWidth: "4ch", color: "var(--text-faint)" },
    ".cm-changedLine, .cm-insertedLine, &.cm-merge-b .cm-changedLine": { backgroundColor: "color-mix(in srgb, var(--git-added) 10%, transparent)" },
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "color-mix(in srgb, var(--git-deleted) 10%, transparent)" },
    ".cm-changedText, &.cm-merge-b .cm-changedText": { background: "color-mix(in srgb, var(--git-added) 22%, transparent)" },
    "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": { background: "color-mix(in srgb, var(--git-deleted) 22%, transparent)" },
    ".cm-pureInsert .cm-changedText": { background: "none" },
    ".cm-deletedChunk": { paddingLeft: "0" },
    ".cm-insertedLine, .cm-deletedLine, .cm-deletedLine del": { textDecoration: "none" },
    ".cm-changeGutter": { width: "2px", paddingLeft: "0" },
    ".cm-changedLineGutter, &.cm-merge-b .cm-changedLineGutter": { background: "var(--git-added)" },
    "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: "var(--git-deleted)" },
    // A folded stretch: one quiet line of the grid ("⋯ 14 unchanged lines"); a click opens it.
    ".cm-collapsedLines": {
      padding: "0 var(--inset) 0 var(--space-2)", margin: "0", font: "inherit", lineHeight: "inherit", color: "var(--text-faint)",
      background: "none", border: "none", cursor: "pointer",
    },
    ".cm-collapsedLines:hover": { color: "var(--text-dim)", background: "var(--bg-hover)" },
    ".cm-collapsedLines:before": { content: '"⋯ "', position: "static", border: "none", height: "auto", width: "auto", background: "none" },
    ".cm-collapsedLines:after": { content: "none" },
    // Lines another version changes too: their number and a bar in the warning colour.
    ".cm-gutterElement.cm-clash": { boxShadow: "inset 2px 0 0 var(--warning)", color: "var(--warning)" },
    ".cm-line.cm-clash": { backgroundImage: "linear-gradient(90deg, color-mix(in srgb, var(--warning) 14%, transparent), transparent 40%)" },
    ".cm-flash-line": { animation: "cm-diff-flash calc(var(--glide-dur) * 5) var(--ease) forwards" },
    "@keyframes cm-diff-flash": { from: { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" }, to: { backgroundColor: "transparent" } },
  }),
);

/** Base line ranges [from, to] (1-based, inclusive) a version changes; an insertion is the line it goes before. */
export function changedBaseLines(before: string, after: string): [number, number][] {
  const base = EditorState.create({ doc: before }).doc;
  return presentableDiff(before, after).map((c) => {
    const a = base.lineAt(Math.min(c.fromA, base.length)).number;
    const b = base.lineAt(Math.min(Math.max(c.fromA, c.toA - 1), base.length)).number;
    return [a, b];
  });
}

/** The lines of `after` (positions) that change base lines another version changes too. */
function clashLines(before: string, after: string, others: readonly OtherVersion[]): { from: number; names: string[] }[] {
  if (!others.length) return [];
  const mine = changedBaseLines(before, after);
  const theirs = others.map((o) => ({ name: o.name, ranges: changedBaseLines(before, o.after) }));
  // Base offsets → this version's offsets: the diff as a change set.
  const changes = ChangeSet.of(presentableDiff(before, after).map((c) => ({ from: c.fromA, to: c.toA, insert: after.slice(c.fromB, c.toB) })), before.length);
  const base = EditorState.create({ doc: before }).doc;
  const doc = EditorState.create({ doc: after }).doc;
  const out = new Map<number, Set<string>>();
  for (const [a1, a2] of mine)
    for (const t of theirs)
      for (const [b1, b2] of t.ranges) {
        if (a1 > b2 || b1 > a2) continue;
        const from = doc.lineAt(Math.min(changes.mapPos(base.line(Math.max(a1, b1)).from, -1), doc.length)).number;
        const to = doc.lineAt(Math.min(changes.mapPos(base.line(Math.min(a2, b2)).to, 1), doc.length)).number;
        for (let l = from; l <= to; l++) (out.get(l) ?? out.set(l, new Set()).get(l)!).add(t.name);
      }
  return [...out.entries()].map(([l, names]) => ({ from: doc.line(l).from, names: [...names] }));
}

const clashMarker = new (class extends GutterMarker {
  override elementClass = "cm-clash";
})();

/** Marks lines (and their gutter) that another version changes too. */
function clashMarks(lines: { from: number; names: string[] }[]): Extension {
  const build = (doc: EditorState["doc"]) => {
    const d = new RangeSetBuilder<Decoration>();
    const g = new RangeSetBuilder<GutterMarker>();
    for (const l of lines) {
      if (l.from > doc.length) continue;
      d.add(l.from, l.from, Decoration.line({ class: "cm-clash", attributes: { title: `${l.names.join(" and ")} change${l.names.length === 1 ? "s" : ""} this too` } }));
      g.add(l.from, l.from, clashMarker);
    }
    return { deco: d.finish(), gutter: g.finish() };
  };
  const field = StateField.define<{ deco: DecorationSet; gutter: RangeSet<GutterMarker> }>({
    create: (s) => build(s.doc),
    update: (v, tr) => ({ deco: v.deco.map(tr.changes), gutter: v.gutter.map(tr.changes) }),
    provide: (f) => [EditorView.decorations.from(f, (v) => v.deco), gutterLineClass.from(f, (v) => v.gutter)],
  });
  return field;
}

/** Lines of chunks that only add (nothing replaced): their words aren't marked, the line's tint says it all. */
const pureInserts = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) {
      this.decorations = this.build(v);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || getChunks(u.state) !== getChunks(u.startState)) this.decorations = this.build(u.view);
    }
    build(v: EditorView) {
      const b = new RangeSetBuilder<Decoration>();
      const doc = v.state.doc;
      for (const c of getChunks(v.state)?.chunks ?? []) {
        if (c.fromA !== c.toA || c.fromB === c.toB) continue;
        for (let l = doc.lineAt(c.fromB).number; l <= doc.lineAt(Math.min(c.endB, doc.length)).number; l++) b.add(doc.line(l).from, doc.line(l).from, Decoration.line({ class: "cm-pureInsert" }));
      }
      return b.finish();
    }
  },
  { decorations: (p) => p.decorations },
);

/** The editor pieces both modes share: read-only, numbered, highlighted, in the app's look. */
function base(font: string, size: number, dark: boolean, lang: Compartment, extra: Extension = []): Extension {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    lineNumbers(),
    syntaxHighlighting(syntax),
    appTheme(font, size, dark),
    diffTheme,
    flashChanges,
    pureInserts,
    lang.of([]),
    extra,
  ];
}

/** One file's change, before and after (see the file's header). */
export const FileDiff = forwardRef<FileDiffHandle, FileDiffProps>(function FileDiff({ path, before, after, mode = "unified", others = [], context = 3, onPlace }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const views = useRef<{ main: EditorView; merge?: MergeView } | null>(null);
  const lang = useRef(new Compartment());
  const settings = useStoreValue((s) => s.settings.settings);
  const dark = useTheme().appearance === "dark";
  const font = settings["font.code"];
  const size = settings["font.codeSize"];
  const [marks, setMarks] = useState<{ top: number; height: number; kind: "add" | "del" | "change" }[]>([]);
  const place = useRef(onPlace);
  place.current = onPlace;

  // The view: made again when what it is changes (mode, look, the base, the others); a new `after` only edits it.
  const shown = useRef(after);
  useEffect(() => {
    const el = host.current!;
    const clash = clashMarks(clashLines(before, after, others));
    const collapse = { margin: context, minSize: context + 4 };
    const track = EditorView.updateListener.of((u) => (u.docChanged || u.geometryChanged || u.viewportChanged) && measure());
    const scroll = EditorView.domEventHandlers({ scroll: () => void measure() });
    let main: EditorView;
    let merge: MergeView | undefined;
    if (mode === "split") {
      merge = new MergeView({
        parent: el,
        a: { doc: before, extensions: base(font, size, dark, lang.current) },
        b: { doc: after, extensions: base(font, size, dark, lang.current, [clash, track, scroll]) },
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: collapse,
      });
      main = merge.b;
    } else {
      main = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: after,
          extensions: [base(font, size, dark, lang.current, [clash, track, scroll]), unifiedMergeView({ original: before, mergeControls: false, gutter: true, highlightChanges: true, syntaxHighlightDeletions: true, collapseUnchanged: collapse })],
        }),
      });
    }
    shown.current = after;
    views.current = { main, merge };
    const desc = LanguageDescription.matchFilename(languages, path.split("/").pop() ?? "");
    if (desc)
      void desc.load().then((l) => {
        for (const v of merge ? [merge.a, merge.b] : [main]) v.dispatch({ effects: lang.current.reconfigure(l) });
      });
    measure();
    return () => {
      merge ? merge.destroy() : main.destroy();
      views.current = null;
    };
  }, [path, before, mode, font, size, dark, context, others.map((o) => o.name + o.after.length).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  // The agent wrote again: change only what differs, lit for a moment; in split, the right side.
  useEffect(() => {
    const v = views.current?.main;
    if (!v || after === shown.current) return;
    if (v.state.doc.lines <= FLASH_MAX_LINES) applyAndFlash(v, after);
    else {
      const c = minimalChange(v.state.doc.toString(), after);
      if (c) v.dispatch({ changes: c });
    }
    shown.current = after;
  }, [after]);

  /** The ruler's marks and where the view is among the changes. */
  function measure() {
    const v = views.current?.main;
    if (!v) return;
    const chunks: readonly Chunk[] = (views.current?.merge?.chunks ?? getChunks(v.state)?.chunks) || [];
    // The whole file onto the view's height when it's taller; where the lines are when it fits.
    const view = v.scrollDOM.clientHeight;
    const scale = v.contentHeight > view ? view / v.contentHeight : 1;
    setMarks(
      chunks.map((c) => {
        const top = v.lineBlockAt(Math.min(c.fromB, v.state.doc.length)).top;
        const end = c.toB > c.fromB ? v.lineBlockAt(Math.min(Math.max(c.fromB, c.toB - 1), v.state.doc.length)).bottom : top;
        return { top: top * scale, height: Math.max(2, (end - top) * scale), kind: c.fromA === c.toA ? "add" : c.fromB === c.toB ? "del" : "change" };
      }),
    );
    const y = v.scrollDOM.scrollTop + 4;
    place.current?.({ count: chunks.length, at: chunks.filter((c) => v.lineBlockAt(Math.min(c.fromB, v.state.doc.length)).top <= y).length - 1 });
  }

  useImperativeHandle(ref, () => ({
    next: () => {
      const v = views.current?.main;
      if (v) goToNextChunk(v), v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: "start", yMargin: 40 }) });
    },
    prev: () => {
      const v = views.current?.main;
      if (v) goToPreviousChunk(v), v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: "start", yMargin: 40 }) });
    },
  }));

  return (
    <div className="file-diff" data-mode={mode}>
      <div ref={host} className="file-diff-host" />
      <div className="file-diff-ruler" aria-hidden>
        {marks.map((m, i) => (
          <span key={i} data-kind={m.kind} style={{ top: m.top, height: m.height }} />
        ))}
      </div>
    </div>
  );
});

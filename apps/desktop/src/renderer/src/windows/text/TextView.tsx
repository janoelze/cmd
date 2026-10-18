// Text window: a CodeMirror 6 editor for one file, or an untitled buffer
// (File › New Text Editor) whose first ⌘S asks where to save. No toolbar — the title bar
// (or, in focus mode, the status bar) shows the file, folder and state; ⌘S saves.
//
//  - Styled from the app's tokens (background, separators, selection, terminal
//    font) with syntax colours from the terminal palette (--syn-* in styles.css).
//  - Live: the file is watched; outside changes merge in as a minimal edit
//    (cursor and scroll survive) when there are no unsaved edits, otherwise a
//    banner asks whether to reload or keep yours. Saving never silently
//    overwrites a file that changed on disk.
//  - Untitled: the text is kept in the window's state (`draft`), so it survives
//    reloads and core restarts until it's saved.
//  - Kept as it was: the file's indentation and line endings (editor/setup.ts),
//    and where you were (`pos`: the cursor and the top line, back after a reload).
//  - The title bar says where the cursor is while you edit (Ln, Col), the file's
//    size otherwise. Word wrap follows `editor.wordWrap`; ⌘+ ⌘− ⌘0 size this
//    window's text; the editor's commands are windows/text/commands.ts.

import { Button, Callout, EmptyState } from "@cmd/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment, EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import { copyLineDown, deleteLine, indentLess, indentMore, moveLineDown, moveLineUp, toggleComment } from "@codemirror/commands";
import { searchPanelOpen } from "@codemirror/search";
import { foldAll, foldCode, LanguageDescription, syntaxHighlighting, unfoldAll, unfoldCode } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { formatBytes } from "../../lib/model.ts";
import { onFsChanged, useStoreValue } from "../../lib/store.ts";
import { registerWindowActions, setWindowStatus, type TextEdit } from "../../lib/windowActions.ts";
import { syntax } from "../../editor/syntax.ts";
import { appTheme, minimalChange } from "../../editor/theme.ts";
import { editorSetup, fileFormat } from "../../editor/setup.ts";
import { diskChange } from "../../editor/disk.ts";
import { editorFindable, findPanel } from "../../editor/find.ts";
import { shareFindQuery, useFind } from "../../lib/find.tsx";
import { useTheme } from "@cmd/ui/themes";

type ReadResult = { text: string; size: number; mtime: number; truncated: boolean; binary: boolean };
/** Where you were in the file: the cursor (1-based line, 0-based column) and the top line shown. */
type Pos = { line: number; col: number; top: number };

const EDITS: Record<TextEdit, Command> = {
  toggleComment, moveLineUp, moveLineDown, duplicateLine: copyLineDown, deleteLine, indent: indentMore, outdent: indentLess,
  fold: foldCode, unfold: unfoldCode, foldAll, unfoldAll,
};
/** ⌘+ ⌘− change the window's text size in these steps, from the code font's size. */
const ZOOM_MIN = -6;
const ZOOM_MAX = 16;

/** The title bar's cursor: line and column (1-based), how much is selected, how many cursors. */
function cursorOf(state: EditorState) {
  const sel = state.selection;
  const head = sel.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1, selected: sel.ranges.reduce((n, r) => n + r.to - r.from, 0), cursors: sel.ranges.length };
}

export function TextView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const file = typeof win.state.path === "string" ? win.state.path : "";
  const dir = typeof win.state.dir === "string" ? win.state.dir : "";
  const fileRef = useRef(file);
  fileRef.current = file;
  const settings = useStoreValue((s) => s.settings.settings);
  const dark = useTheme().appearance === "dark";
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef<Text | null>(null);
  const comps = useRef({ lang: new Compartment(), readOnly: new Compartment(), theme: new Compartment(), format: new Compartment(), wrap: new Compartment() });
  const wrap = settings["editor.wordWrap"] !== false;
  /** ⌘+ ⌘− ⌘0: this window's text size, a step from the code font's (kept in its state). */
  const zoom = typeof win.state.zoom === "number" ? win.state.zoom : 0;
  const fontSize = settings["font.codeSize"] + zoom;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const meta = useRef({ size: 0, mtime: 0, truncated: false, binary: false });
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [lines, setLines] = useState(0);
  /** Where the cursor is, for the title bar while the editor has focus. */
  const [cursor, setCursor] = useState<{ line: number; col: number; selected: number; cursors: number } | null>(null);
  /** The file has been read once; until then there's no status worth showing. */
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The file changed on disk while there were unsaved edits. */
  const [conflict, setConflict] = useState(false);

  // Create the editor once per window (an untitled buffer keeps it when saved).
  useEffect(() => {
    const c = comps.current;
    const draft = !file && typeof win.state.draft === "string" ? win.state.draft : "";
    let persist: ReturnType<typeof setTimeout> | undefined;
    let remember: ReturnType<typeof setTimeout> | undefined;
    // Where you are, a moment after you stop moving (it's a window.update each time).
    const keepPos = () => {
      clearTimeout(remember);
      remember = setTimeout(() => {
        const v = view.current;
        if (!v || !restored.current) return;
        const head = v.state.selection.main.head;
        const line = v.state.doc.lineAt(head);
        const top = v.state.doc.lineAt(v.lineBlockAtHeight(v.scrollDOM.scrollTop).from).number;
        void cmd.call("window.update", { id: win.id, state: { pos: { line: line.number, col: head - line.from, top } satisfies Pos } }).catch(() => {});
      }, 1000);
    };
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: draft,
        extensions: [
          editorSetup,
          findPanel,
          // Like a terminal's "Terminal input"; the window around it carries the file's name.
          EditorView.contentAttributes.of({ "aria-label": "Text editor" }),
          syntaxHighlighting(syntax),
          c.theme.of(appTheme(settings["font.code"], fontSize, dark)),
          c.lang.of([]),
          c.format.of(fileFormat(draft)),
          c.wrap.of(wrap ? EditorView.lineWrapping : []),
          c.readOnly.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of((u) => {
            if (findOpen.current && searchPanelOpen(u.startState) && !searchPanelOpen(u.state)) closeFind.current("close");
            if (u.selectionSet || u.docChanged || u.focusChanged) setCursor(u.view.hasFocus ? cursorOf(u.state) : null);
            if (u.selectionSet || u.docChanged) keepPos();
            if (!u.docChanged) return;
            setDirty(!!saved.current && !u.state.doc.eq(saved.current));
            setLines(u.state.doc.lines);
            if (fileRef.current) return;
            clearTimeout(persist);
            persist = setTimeout(() => void cmd.call("window.update", { id: win.id, state: { draft: u.state.sliceDoc() } }).catch(() => {}), 500);
          }),
          EditorView.domEventHandlers({ scroll: () => void keepPos() }),
        ],
      }),
    });
    view.current = v;
    if (!file) {
      // Nothing on disk: unsaved until the first ⌘S.
      saved.current = Text.empty;
      setDirty(draft !== "");
      setLines(v.state.doc.lines);
      setLoaded(true);
      restore();
    }
    return () => {
      clearTimeout(persist);
      clearTimeout(remember);
      v.destroy();
      view.current = null;
    };
  }, [win.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const desc = file ? LanguageDescription.matchFilename(languages, file.split("/").pop() ?? "") : null;
    if (desc) void desc.load().then((lang) => view.current?.dispatch({ effects: comps.current.lang.reconfigure(lang) }));
    else view.current?.dispatch({ effects: comps.current.lang.reconfigure([]) });
  }, [file]);

  useEffect(() => {
    view.current?.dispatch({ effects: comps.current.theme.reconfigure(appTheme(settings["font.code"], fontSize, dark)) });
  }, [settings["font.code"], fontSize, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({ effects: comps.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  /** Back where you were (`pos`), once, when the file is first shown; then where you are is kept. */
  const restored = useRef(false);
  const restore = useCallback(() => {
    const v = view.current;
    if (!v || restored.current) return;
    restored.current = true;
    const pos = win.state.pos as Pos | undefined;
    if (!pos || win.state.reveal) return;
    const doc = v.state.doc;
    const line = doc.line(Math.min(Math.max(1, pos.line), doc.lines));
    const top = doc.line(Math.min(Math.max(1, pos.top), doc.lines));
    v.dispatch({ selection: EditorSelection.cursor(Math.min(line.from + pos.col, line.to)), effects: EditorView.scrollIntoView(top.from, { y: "start" }) });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Show what was read: merged into the buffer as a minimal change (cursor and scroll survive). */
  const apply = useCallback((r: ReadResult) => {
    const v = view.current;
    if (!v) return;
    meta.current = r;
    setError(null);
    // Its indentation and line endings first, so the text reads in (and saves) as the file has it.
    v.dispatch({ effects: comps.current.format.reconfigure(fileFormat(r.text)) });
    const change = minimalChange(v.state.sliceDoc(), r.text);
    if (change) v.dispatch({ changes: change });
    saved.current = v.state.doc;
    setDirty(false);
    setConflict(false);
    setLines(v.state.doc.lines);
    setLoaded(true);
    v.dispatch({ effects: comps.current.readOnly.reconfigure(EditorState.readOnly.of(r.truncated || r.binary)) });
    restore();
  }, [restore]);

  /** Load the file. */
  const load = useCallback(async () => {
    if (!file) return;
    try {
      apply(await cmd.call("fs.read", { path: file }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [file, apply]);
  useEffect(() => void load(), [load]);

  // Live: watch the file; reload when clean, ask when there are unsaved edits.
  useEffect(() => {
    if (!file) return;
    void cmd.call("fs.watch", { path: file }).catch(() => {});
    const off = onFsChanged((p) => {
      if (p !== file) return;
      // Gone (deleted, moved away): the window keeps its text, to save again.
      // Every event reads after it, and the core answers in order: the last read is the disk now.
      void cmd.call("fs.read", { path: file }).then(
        (r) => {
          const v = view.current;
          if (!v || fileRef.current !== file) return;
          // By content: a save's mtime may be the next writer's (see editor/disk.ts).
          const known = saved.current;
          const change = diskChange(r.text, v.state.sliceDoc(), known ? known.sliceString(0, undefined, v.state.lineBreak) : null, !!known && !v.state.doc.eq(known));
          if (change === "unchanged") meta.current = { ...meta.current, mtime: r.mtime };
          else if (change === "conflict") setConflict(true);
          else apply(r);
        },
        () => {},
      );
    });
    return () => {
      off();
      void cmd.call("fs.unwatch", { path: file }).catch(() => {});
    };
  }, [file, apply]);

  useEffect(() => {
    if (!focused) return;
    const active = document.activeElement;
    const typing = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && !active.closest(".xterm");
    if (!typing) view.current?.focus();
  }, [focused]);

  const save = useCallback(async () => {
    const v = view.current;
    const m = meta.current;
    if (!v || m.truncated || m.binary) return;
    try {
      // Untitled: ask where (the save panel confirms overwriting), then the window becomes that file's.
      const target = file || (await cmd.chooseSavePath(`${dir || "~"}/Untitled.txt`));
      if (!target) return;
      const doc = v.state.doc;
      const r = await cmd.call("fs.write", { path: target, text: doc.sliceString(0, undefined, v.state.lineBreak), expectMtime: file ? m.mtime : undefined });
      meta.current = { ...m, size: r.size, mtime: r.mtime };
      if (!file) await cmd.call("window.update", { id: win.id, state: { path: target } });
      saved.current = doc;
      setDirty(!v.state.doc.eq(doc));
      setConflict(false);
      setNotice("Saved");
      setTimeout(() => setNotice(null), 1500);
    } catch (e) {
      setNotice(null);
      setConflict(/changed on disk/i.test((e as Error).message));
      if (!/changed on disk/i.test((e as Error).message)) setError((e as Error).message);
    }
  }, [file, dir, win.id]);

  /** Keep my edits: overwrite the disk version on the next save. */
  const keepMine = async () => {
    const r = await cmd.call("fs.read", { path: file }).catch(() => null);
    if (r) meta.current = { ...meta.current, mtime: r.mtime };
    setConflict(false);
  };

  // Find (⌘F ⌘G ⇧⌘G, ⌥⌘F replace) with the app's bar; replace only where the text can be edited.
  const editable = !meta.current.truncated && !meta.current.binary;
  const findable = editorFindable(() => view.current, () => editable);
  const find = useFind(editable ? findable : { ...findable, replace: undefined }, { onClose: () => view.current?.focus() });
  // Escape in the editor closes CodeMirror's (hidden) panel, and with it the matches: the bar goes too.
  const findOpen = useRef(find.open);
  findOpen.current = find.open;
  const closeFind = useRef(find.request);
  closeFind.current = find.request;

  useEffect(
    () =>
      registerWindowActions(win.id, {
        save,
        openExternally: file ? () => cmd.openPath(file, { from: "user" }) : undefined,
        // The menu bar owns ⌘F ⌘G ⇧⌘G, so CodeMirror's own bindings for them don't fire.
        find: find.request,
        // ⌘E to a preview (a JSON tree) selects what is on this line.
        line: () => (view.current ? view.current.state.doc.lineAt(view.current.state.selection.main.head).number : null),
        zoom: (d) => {
          const next = d === 0 ? 0 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomRef.current + d));
          if (next !== zoomRef.current) void cmd.call("window.update", { id: win.id, state: { zoom: next } }).catch(() => {});
        },
        text: {
          lines: () => view.current?.state.doc.lines ?? 0,
          goToLine: (n, column) => {
            const v = view.current;
            if (!v) return;
            const line = v.state.doc.line(Math.min(Math.max(1, n), v.state.doc.lines));
            const at = Math.min(line.from + Math.max(0, (column ?? 1) - 1), line.to);
            v.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) });
            v.focus();
          },
          run: (name) => {
            const v = view.current;
            if (v) EDITS[name](v);
          },
          focused: () => !!view.current?.hasFocus,
          selection: () => {
            const st = view.current?.state;
            return st ? st.sliceDoc(st.selection.main.from, st.selection.main.to) : "";
          },
        },
      }),
    [win.id, save, file, find.request],
  );

  // A search result opened here: its line in the middle, the text found selected, and ⌘G finds it again.
  const reveal = win.state.reveal as { line: number; column: number | null; text: string | null; at: number } | undefined;
  const revealed = useRef(0);
  useEffect(() => {
    const v = view.current;
    if (!v || !loaded || !reveal || reveal.at === revealed.current) return;
    revealed.current = reveal.at;
    const line = v.state.doc.line(Math.min(Math.max(1, reveal.line), v.state.doc.lines));
    let from = line.from;
    let to = line.from;
    if (reveal.text) {
      const hay = line.text.toLowerCase();
      const needle = reveal.text.toLowerCase();
      const near = reveal.column ? hay.indexOf(needle, Math.max(0, reveal.column - 3)) : -1;
      const at = near >= 0 ? near : hay.indexOf(needle);
      if (at >= 0) (from = line.from + at), (to = from + reveal.text.length);
      shareFindQuery(reveal.text);
    }
    v.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(EditorSelection.range(from, to), { y: "center" }) });
    v.focus();
  }, [loaded, reveal?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the title bar / status bar shows for this window: where the cursor is while you edit, else what the file is.
  const m = meta.current;
  const at = cursor && (cursor.cursors > 1 ? `${cursor.cursors} cursors` : `Ln ${cursor.line}, Col ${cursor.col}${cursor.selected ? ` (${cursor.selected} selected)` : ""}`);
  const label =
    notice ??
    (m.truncated ? "Read-only (truncated)" : m.binary ? "Read-only (binary)" : at ? (dirty ? `Edited · ${at}` : at) : dirty ? "Edited" : !file ? "Empty" : `${lines} lines · ${formatBytes(m.size)}`);
  // The key says which state it is: a new key animates, line counts and the cursor update in place.
  const key = notice ? "notice" : m.truncated || m.binary ? "readonly" : dirty ? "edited" : at ? "cursor" : "info";
  useEffect(
    () => setWindowStatus(win.id, loaded || notice ? { label, key, dirty } : null),
    [win.id, label, key, dirty, loaded, notice],
  );
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  return (
    <div className="textwin">
      {conflict && (
        <Callout
          banner
          compact
          tone="warning"
          actions={
            <>
              <Button size="sm" onClick={() => void load()}>
                Reload
              </Button>
              <Button size="sm" onClick={() => void keepMine()}>
                Keep Mine
              </Button>
            </>
          }
        >
          This file changed on disk.
        </Callout>
      )}
      {find.bar}
      {error && <EmptyState compact icon="warning">{error}</EmptyState>}
      <div className="textwin-editor" ref={host} />
    </div>
  );
}
